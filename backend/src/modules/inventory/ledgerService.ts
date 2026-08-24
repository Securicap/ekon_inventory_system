import {
  movementTypeSchema,
  quantityDeltaSchema,
  REASON_REQUIRED_MOVEMENT_TYPES,
  type MovementType,
} from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError, conflict } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import {
  findReversalOf,
  getMovementById,
  insertMovement,
  insertReversal,
  insertZeroBalance,
  isDuplicateReversalViolation,
  lockBalance,
  MOVEMENT_RESULT_RESOURCE_TYPE,
  updateBalance,
  type LockedBalance,
  type PostedMovement,
} from './infrastructure/ledgerRepository.js';
import {
  assertOperationMatchesClaim,
  claimOperation,
  completeOperation,
  getOperation,
  type OperationClaim,
} from './infrastructure/operationRepository.js';

/**
 * The posting engine: the one trusted path that puts a movement in the ledger.
 *
 * It is internal on purpose. Nothing HTTP reaches it — there is no route and no
 * request schema. Receiving, removal, adjustment, and reversal are thin callers
 * built on top of it. What exists here is the atomic step they all share: claim
 * the operation, check whatever the workflow says must still be true, lock the
 * balance, derive the quantities, append one movement, move the projection,
 * record the result — all in one transaction, or none of it (INV-5).
 *
 * Two entry points, because reversal genuinely is a different command rather
 * than a normal one with a flag. `postMovement` is told what to move;
 * `postReversal` is told which movement was wrong and works the rest out from
 * the ledger. They share every protection — the claim, the lock, the chain, the
 * stock floor, the projection update — and differ in exactly the part that
 * differs.
 *
 * Quantities are never accepted from the caller. `quantityBefore`,
 * `quantityAfter`, and `previousMovementId` are read from the locked balance
 * inside the transaction, because a client-supplied before/after is a
 * client-supplied lie waiting to happen.
 *
 * Neither is the permanent identity of the movement, nor the time the system
 * claims to have recorded it. The caller describes the business event — what
 * moved, where, how much, why, who, and when it physically happened — and the
 * engine owns the system metadata: the movement id and `recordedAt`. A caller
 * that could choose either could forge a record's identity or backdate the
 * ledger's own account of when it learned about the stock.
 */

/**
 * Read-only access: the pool, or a transaction already in progress.
 *
 * Only the replay comparison uses this. Posting runs entirely on a transaction
 * client, and nothing that writes is reachable through it.
 */
type Queryable = DatabasePool | DatabaseClient;

/** Every movement type this engine can post. Reversal is deliberately absent. */
export type PostableMovementType = Exclude<MovementType, 'REVERSAL'>;

export interface PostMovementCommand {
  /**
   * Generated once per command, before the first attempt, and reused on every
   * retry — including after a page reload. A fresh id per retry defeats
   * duplicate protection entirely (INV-7).
   *
   * This is the one identifier the caller still owns, and it has to be: it is
   * how a retry names the command it is repeating. The movement's own id is not
   * the caller's business — a replay is answered from the operation's result
   * pointer, so no caller ever has to remember one.
   */
  operationId: string;
  operationType: string;
  /**
   * Digest of the canonical request, compared on replay to catch a changed body.
   *
   * It covers business fields only. The movement id and `recordedAt` are not
   * request fields, so nothing that hashes a request should reach for them.
   */
  requestHash: string;
  variantId: string;
  locationId: string;
  movementType: PostableMovementType;
  quantityDelta: number;
  reasonCode: string | null;
  note: string | null;
  /**
   * Who is accountable for the movement (INV-11).
   *
   * The ledger is internal and knows nothing about HTTP: it trusts whatever
   * workflow calls it. When receiving and the other workflows arrive, each will
   * derive this from `request.actor.id` — the authenticated session — and no
   * request schema will ever accept a user id from the wire.
   */
  userId: string;
  /**
   * When the stock physically moved. Business time, and the caller's to state:
   * a delivery counted this morning and entered this afternoon occurred this
   * morning. It may precede the server's `recordedAt`, and that is not an error.
   */
  occurredAt: Date;
  /** See {@link MovementPrecondition}. */
  precondition?: MovementPrecondition;
}

/**
 * What the workflow says must still be true at the moment the movement is
 * written, checked inside the posting transaction.
 *
 * The engine runs it after claiming the operation and before touching any
 * balance, and knows nothing about what it does. It throws — an `AppError` the
 * caller's route already maps — and the whole unit of work rolls back, so a
 * refusal leaves no operation row, no movement, and no balance change.
 *
 * **It exists because some validation cannot honestly happen before the
 * transaction.** Whether a variant may be received into is not a fact a
 * workflow can read on the pool and still rely on: merchandise can be archived
 * between the read and the write, and then archived merchandise has stock on a
 * shelf. Inside the transaction the check can take a lock, and the lifecycle
 * change either waits for this movement or this movement waits for it. One of
 * the two is refused, deliberately, rather than both succeeding.
 *
 * A closure rather than a dependency on the catalog, and rather than an
 * `intent` field the engine would interpret: the engine has no business knowing
 * what merchandise lifecycle is, and a workflow that grew a second precondition
 * would otherwise have to teach it. What the engine owns is *when* the check
 * runs and that a failure takes everything with it.
 */
export type MovementPrecondition = (tx: DatabaseClient) => Promise<void>;

export interface LedgerServiceDeps {
  pool: DatabasePool;
  /** Stamps the operation, the movement, and the balance. Never `new Date()`. */
  clock: Clock;
  /** Mints movement ids. Defaults to the application's UUIDv7 generator. */
  generateId?: () => string;
}

/**
 * How a caller names a command it may have sent before.
 *
 * Defined with the `operations` table it is compared against, and re-exported
 * here because every workflow that reaches the ledger names its command this
 * way. Physical counts claim operations without posting a movement, which is
 * why the type belongs beside the mechanism rather than beside the engine.
 */
export type { OperationClaim };

/**
 * One reversal command: which movement was wrong, and who says so.
 *
 * Notice what is **not** here. No variant, no location, no quantity, no
 * movement type, and no direction — every one of them is read off the original
 * movement inside the transaction, because the original is the authority on
 * what it did. A command that carried them could name a quantity the original
 * never moved, and the ledger would record a correction that corrects nothing.
 */
export interface PostReversalCommand {
  /** Generated once per command and reused on every retry, as everywhere (INV-7). */
  operationId: string;
  operationType: string;
  /** Digest of the canonical request. Business fields only. */
  requestHash: string;
  /** The movement being reversed. Read, never written. */
  movementId: string;
  /** Free text: why it was wrong. The reversal's reason is the original itself. */
  note: string | null;
  /** Who is accountable for the correction, from the authenticated session. */
  userId: string;
  /**
   * Business time of the **correction**, not of the original movement. The
   * mistake happened when it happened; this is when somebody put it right.
   */
  occurredAt: Date;
  /**
   * Checked inside the transaction, once the original has been read and the
   * variant is therefore known. See {@link MovementPrecondition}.
   */
  precondition?: (tx: DatabaseClient, variantId: string) => Promise<void>;
}

export interface LedgerService {
  /**
   * Posts one movement in a transaction of the engine's own.
   *
   * What every workflow whose whole command *is* the movement uses: receiving,
   * removal, and adjustment each describe a business event and have nothing
   * else to write.
   */
  postMovement(command: PostMovementCommand): Promise<PostedMovement>;
  /**
   * The same posting, in a transaction the **caller** already opened.
   *
   * It exists for exactly one situation, and the situation is real: reconciling
   * a physical count has to write two things — the movement, and the count
   * record that says the discrepancy was accepted — and they have to commit
   * together or not at all. A count marked reconciled with no movement behind
   * it is a stock change the shop believes happened and did not; a movement
   * whose count still reads unresolved is a stock change nobody can explain.
   *
   * The alternatives were both worse. Calling `postMovement` from inside
   * another transaction would open a second one and commit half the workflow —
   * INV-5 broken by the code that most depends on it. Reimplementing the claim,
   * the lock, the chain, the floor and the projection update inside the count
   * service would be a second ledger, and the second one is the one that gets
   * the stock floor wrong.
   *
   * **This is the same code path**, not a variant of it: `postMovement` is a
   * `withTransaction` wrapper around this function, so there is one posting
   * algorithm and one place any of it can be changed.
   *
   * The caller must already be inside `withTransaction`. The signature says so
   * as loudly as a type can — `DatabaseClient` is a transaction client and the
   * pool is not one — and a caller that passes a client without a transaction
   * open would leak a claim and a movement as separate autocommits, which is
   * the thing this whole file exists to prevent.
   */
  postMovementInTransaction(
    tx: DatabaseClient,
    command: PostMovementCommand,
  ): Promise<PostedMovement>;
  /**
   * Appends a `REVERSAL` compensating one earlier movement, atomically.
   *
   * Everything about the reversal except the note, the actor, and the business
   * time is derived from the movement it names: the variant, the location, and
   * a `quantityDelta` that is the exact negation of the original's. The original
   * row is read and never written — no path in this system updates or deletes a
   * movement, and the database refuses both (INV-1).
   *
   * **It works against the current balance, not against history.** Reversing a
   * receipt of 10 that has since had 3 issued against it would leave −3 on the
   * shelf, and it is refused with `INSUFFICIENT_STOCK` rather than clamped
   * (INV-8). A historical receipt is not permission to break the stock floor;
   * the later movements are corrected first.
   *
   * Refuses, as conflicts: a movement that does not exist, a movement that is
   * itself a `REVERSAL`, and a movement that has already been reversed. The
   * last of those is also a database constraint, which is what makes it true
   * under concurrency (INV-2).
   */
  postReversal(command: PostReversalCommand): Promise<PostedMovement>;
  /**
   * Answers a command that may already have been posted, without posting.
   *
   * Returns the movement a **completed** operation produced, or `null` when
   * this engine has nothing to answer with yet — either no such operation, or
   * one that is claimed but has not committed its result. `null` means "carry
   * on and post"; it never means "this is new", because only the transactional
   * claim inside `postMovement` can decide that.
   *
   * It exists because current-state validation and replay disagree about time.
   * A workflow must refuse to receive stock against a variant that was retired
   * *today*; it must also answer a retry of a receipt that was posted while
   * that variant was still active, and answer it identically however long the
   * retry took to arrive. A completed operation is a fact about the past, so
   * asking about it first is what lets a workflow validate the present without
   * making a settled movement unreachable.
   *
   * A mismatched operation type or request hash raises
   * `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` here, exactly as it would inside
   * the transaction — one operation id has been used for two different
   * commands, and the second one must not be validated, let alone posted.
   *
   * This is a read. It takes no lock, claims nothing, and is not an
   * idempotency mechanism: it cannot create an operation, cannot complete one,
   * and cannot stop two callers racing. It is a shortcut to an answer the
   * engine already holds, and the engine remains the only thing that decides
   * who owns a command.
   */
  findCompletedMovement(claim: OperationClaim): Promise<PostedMovement | null>;
}

/**
 * Which way each movement type is allowed to move stock.
 *
 * Exhaustive over `PostableMovementType`, so adding a movement type to
 * `shared/src/movements.ts` fails to compile here until someone decides what
 * direction it has. That is the intended friction.
 */
const REQUIRED_DELTA_SIGN: Readonly<Record<PostableMovementType, 'positive' | 'negative' | 'any'>> =
  {
    RECEIPT: 'positive',
    // Stock left through ordinary operations. The workflow states a positive
    // quantity and derives the sign; by the time a command reaches here the
    // delta is negative, and a positive one would be a receipt wearing an
    // issue's name.
    ISSUE: 'negative',
    ADJUSTMENT_IN: 'positive',
    ADJUSTMENT_OUT: 'negative',
    // A count reconciles to what is physically on the shelf, which can be more
    // or less than the system believed.
    COUNT_RECONCILIATION: 'any',
  };

export function createLedgerService(deps: LedgerServiceDeps): LedgerService {
  const generateId = deps.generateId ?? newId;

  /**
   * The posting engine's own transaction, wrapped around the step below.
   *
   * Two lines, and deliberately: every rule about how a movement is written
   * lives in `postMovementInTransaction`, so a workflow that supplies its own
   * transaction gets the identical algorithm rather than a second copy of it.
   */
  async function postMovement(command: PostMovementCommand): Promise<PostedMovement> {
    return withTransaction(deps.pool, (tx) => postMovementInTransaction(tx, command));
  }

  async function postMovementInTransaction(
    tx: DatabaseClient,
    command: PostMovementCommand,
  ): Promise<PostedMovement> {
    // Everything that can be judged without reading the database is judged
    // first, so a malformed command never reaches a statement.
    validateCommand(command);

    {
      // One reading of the server clock stamps everything this transaction
      // writes: the operation, the movement, and the balance. Sampled here
      // because the operation row needs it at the moment of the claim, which is
      // before this transaction learns whether it won. A replay throws it away
      // — nothing is rewritten with it, and the persisted timestamps of the
      // original attempt remain the authoritative ones.
      const recordedAt = deps.clock.now();

      const claimed = await claimOperation(tx, {
        id: command.operationId,
        operationType: command.operationType,
        requestHash: command.requestHash,
        createdAt: recordedAt,
      });

      // Already claimed: this is a retry, or an id reused for something else.
      // Either way, nothing new is posted from here — and no movement id is
      // minted, because the answer is the movement the first attempt posted.
      if (!claimed) return replayOperation(tx, command);

      // Whatever the workflow says must still be true, checked here: inside the
      // transaction, before anything is locked or written, and after the claim
      // so a replay is answered without re-validating a settled command against
      // today's state. A refusal throws and takes the claim with it.
      if (command.precondition) await command.precondition(tx);

      // This transaction owns the command, so it is the one that will produce a
      // movement. Generated after the claim rather than before it, so a retry
      // never mints an identity it has no use for.
      const movementId = generateId();

      const balance = await lockOrCreateBalance(tx, command, recordedAt);

      const quantityBefore = balance.quantityOnHand;
      const quantityAfter = quantityBefore + command.quantityDelta;

      // Stock never goes below zero, for any role, by any path (INV-8). The
      // CHECK constraints are the final protection; this is the readable one.
      if (quantityAfter < 0) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `Insufficient stock: ${quantityBefore} on hand, movement of ${command.quantityDelta} ` +
            `would leave ${quantityAfter}`,
        );
      }

      const movement = await insertMovement(tx, {
        id: movementId,
        variantId: command.variantId,
        locationId: command.locationId,
        movementType: command.movementType,
        quantityDelta: command.quantityDelta,
        quantityBefore,
        quantityAfter,
        // The movement this one continues from. NULL opens the chain, which the
        // partial unique index allows exactly once per (variant, location).
        previousMovementId: balance.lastMovementId,
        operationId: command.operationId,
        reasonCode: command.reasonCode,
        note: command.note,
        userId: command.userId,
        occurredAt: command.occurredAt,
        recordedAt,
      });

      await updateBalance(tx, {
        variantId: command.variantId,
        locationId: command.locationId,
        quantityOnHand: movement.quantityAfter,
        lastMovementId: movement.id,
        updatedAt: recordedAt,
      });

      await completeOperation(tx, {
        id: command.operationId,
        resultResourceType: MOVEMENT_RESULT_RESOURCE_TYPE,
        resultResourceId: movement.id,
      });

      return movement;
    }
  }

  /**
   * The reversal path, and every step of it is deliberate.
   *
   * It reuses the same core protections as `postMovement` — the operation
   * claim, the balance lock, the chain predecessor, the stock floor, the
   * projection update, the operation completion — and adds what only a
   * correction needs: finding the original, refusing to correct the
   * uncorrectable, and deriving the delta from the row rather than from the
   * request.
   *
   * The order inside the transaction is what makes it safe under concurrency:
   *
   *  1. claim the operation — a retry is answered here and posts nothing;
   *  2. read the original — it must exist, and must not itself be a `REVERSAL`;
   *  3. run the workflow's precondition, now that the variant is known;
   *  4. **lock the balance**, which serializes this against every other writer
   *     on the same (variant, location) chain;
   *  5. only then ask whether the original has already been reversed — after
   *     the lock, so a reversal committed by the writer this one just queued
   *     behind is visible. Asking before the lock would read a stale snapshot
   *     and two reversals would both believe they were the first;
   *  6. derive, check the floor, append, move the projection, complete.
   *
   * Step 5 is still not the guarantee. `UNIQUE (reverses_movement_id)` is, and
   * it holds even against a caller that never took the lock — so a lost race
   * surfaces as that constraint and is answered with the same conflict the
   * check would have given.
   */
  async function postReversal(command: PostReversalCommand): Promise<PostedMovement> {
    return withTransaction(deps.pool, async (tx) => {
      const recordedAt = deps.clock.now();

      const claimed = await claimOperation(tx, {
        id: command.operationId,
        operationType: command.operationType,
        requestHash: command.requestHash,
        createdAt: recordedAt,
      });
      if (!claimed) return replayOperation(tx, command);

      const original = await getMovementById(tx, command.movementId);
      if (!original) throw new AppError('NOT_FOUND', 'Inventory movement not found');

      // A reversal of a reversal is refused, and the database refuses it too
      // (0012). Two compensating movements chasing each other is not a
      // correction of a correction — it is a way to move stock indefinitely
      // while every row claims to be undoing something. Re-post the original
      // command instead: that is what "undoing an undo" actually means.
      if (original.movementType === 'REVERSAL') {
        throw conflict(
          'A reversal cannot itself be reversed. To restore what the original movement did, ' +
            'post it again as a new movement.',
        );
      }

      if (command.precondition) await command.precondition(tx, original.variantId);

      const balance = await lockOrCreateBalance(
        tx,
        { variantId: original.variantId, locationId: original.locationId },
        recordedAt,
      );

      const existingReversal = await findReversalOf(tx, original.id);
      if (existingReversal) throw alreadyReversed(original.id, existingReversal.id);

      // The delta comes from the original row and from nowhere else. This single
      // line is the reason the request schema refuses a quantity.
      const quantityDelta = -original.quantityDelta;
      const quantityBefore = balance.quantityOnHand;
      const quantityAfter = quantityBefore + quantityDelta;

      // Against the **current** balance, never against the quantity that
      // followed the original movement. A receipt of 10 with 3 since issued
      // cannot be reversed, because the shelf would owe 3 (INV-8). Nothing is
      // clamped and nothing is partially reversed.
      if (quantityAfter < 0) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `Insufficient stock: ${quantityBefore} on hand, reversing movement ${original.id} ` +
            `would leave ${quantityAfter}. Correct the movements posted after it first.`,
        );
      }

      const movementId = generateId();

      let movement: PostedMovement;
      try {
        movement = await insertReversal(tx, {
          id: movementId,
          variantId: original.variantId,
          locationId: original.locationId,
          quantityDelta,
          quantityBefore,
          quantityAfter,
          previousMovementId: balance.lastMovementId,
          operationId: command.operationId,
          reversesMovementId: original.id,
          reversesMovementType: original.movementType,
          note: command.note,
          userId: command.userId,
          occurredAt: command.occurredAt,
          recordedAt,
        });
      } catch (error) {
        // The check above lost a race it could not have won: another
        // transaction reversed this movement without contending for the same
        // balance row. The database is the protection, and this turns its
        // violation into the answer the caller was owed.
        if (isDuplicateReversalViolation(error)) throw alreadyReversed(original.id, null);
        throw error;
      }

      await updateBalance(tx, {
        variantId: movement.variantId,
        locationId: movement.locationId,
        quantityOnHand: movement.quantityAfter,
        lastMovementId: movement.id,
        updatedAt: recordedAt,
      });

      await completeOperation(tx, {
        id: command.operationId,
        resultResourceType: MOVEMENT_RESULT_RESOURCE_TYPE,
        resultResourceId: movement.id,
      });

      return movement;
    });
  }

  /**
   * The pre-transaction half of the same question `replayOperation` answers
   * after a failed claim. It runs on the pool, so it sees committed operations
   * only — which is exactly right: an uncommitted claim is not yet an answer to
   * anybody, and pretending otherwise is how a caller would end up reporting a
   * movement that then rolled back.
   */
  async function findCompletedMovement(claim: OperationClaim): Promise<PostedMovement | null> {
    const found = await lookUpOperation(deps.pool, claim);
    return found.state === 'completed' ? found.movement : null;
  }

  return { postMovement, postMovementInTransaction, postReversal, findCompletedMovement };
}

/** What the engine knows about an operation id right now. */
type OperationLookup =
  { state: 'unknown' } | { state: 'pending' } | { state: 'completed'; movement: PostedMovement };

/**
 * Reads what an operation id has already produced, and refuses an id that was
 * used for a different command.
 *
 * The one place either of those comparisons is made. Both callers below reach
 * it with the same question and different expectations about what an
 * unresolved answer means, so the *comparison* is shared and the *policy* is
 * stated at each call site rather than guessed at here.
 *
 * `pending` — claimed, with no result recorded — is a real state, not a fault:
 * on the pool it means a concurrent attempt is still in flight. Inside the
 * posting transaction it means something else entirely, which is why this
 * function reports it instead of deciding it.
 *
 * Nothing here writes, and nothing here locks.
 */
async function lookUpOperation(db: Queryable, claim: OperationClaim): Promise<OperationLookup> {
  const existing = await getOperation(db, claim.operationId);
  if (!existing) return { state: 'unknown' };

  // One operation id used for two different commands, refused in the one place
  // that comparison lives — counts make the same comparison about a command
  // that produces no movement at all.
  assertOperationMatchesClaim(existing, claim);

  if (
    existing.resultResourceType !== MOVEMENT_RESULT_RESOURCE_TYPE ||
    existing.resultResourceId === null
  ) {
    return { state: 'pending' };
  }

  const movement = await getMovementById(db, existing.resultResourceId);
  if (!movement) {
    throw new AppError(
      'INTERNAL',
      `Operation ${claim.operationId} points at movement ${existing.resultResourceId}, ` +
        'which does not exist. Refusing to post a second movement.',
    );
  }

  // The movement must be the one this operation produced. A pointer at some
  // other operation's movement means the operations row is wrong, and returning
  // that movement would report a stock change this command never made.
  if (movement.operationId !== claim.operationId) {
    throw new AppError(
      'INTERNAL',
      `Operation ${claim.operationId} points at movement ${movement.id}, which was posted ` +
        `by operation ${movement.operationId}. Refusing to return another operation's movement ` +
        'or to post a second one.',
    );
  }

  return { state: 'completed', movement };
}

/**
 * Answers a command whose operation id was already used, from inside the
 * transaction whose claim just lost. Shared by both entry points: what a replay
 * means does not depend on what kind of movement the first attempt posted.
 *
 * A genuine retry — same operation type, same request hash — returns the
 * movement the first attempt posted. Anything else is refused rather than
 * guessed at: the caller sent two different commands under one identity.
 *
 * Nothing here writes: no movement, no balance change, and no timestamp. The
 * original movement is found through the operation's result pointer, which is
 * why a caller never needs to remember a movement id to retry safely.
 */
async function replayOperation(
  tx: DatabaseClient,
  command: OperationClaim,
): Promise<PostedMovement> {
  const found = await lookUpOperation(tx, command);

  switch (found.state) {
    case 'completed':
      return found.movement;

    // Unreachable in practice: the claim failed because a committed row exists,
    // and operations are never deleted. Guarded rather than assumed.
    case 'unknown':
      throw new AppError(
        'INTERNAL',
        `Operation ${command.operationId} could not be claimed and could not be loaded`,
      );

    // The claim conflicted with a *committed* row — `ON CONFLICT DO NOTHING`
    // waits out an in-flight writer — so the original attempt must have
    // recorded which movement it produced. If it did not, something outside
    // this engine wrote that row, and posting a second movement would silently
    // double the stock. Refusing is the safe answer.
    case 'pending':
      throw new AppError(
        'INTERNAL',
        `Operation ${command.operationId} was already claimed but records no inventory movement ` +
          'result. Refusing to post a second movement.',
      );
  }
}

/**
 * Reads the balance for a (variant, location) under a row lock, creating the
 * zero row first if this shelf has never held stock.
 *
 * The lock is what makes the derived quantities trustworthy: any other writer
 * for the same (variant, location) waits here rather than reading a quantity
 * that is about to change. Never `SUM(quantity_delta)` — the projection is the
 * read model, and summing the ledger under concurrency reads a moving target.
 */
async function lockOrCreateBalance(
  tx: DatabaseClient,
  shelf: { variantId: string; locationId: string },
  recordedAt: Date,
): Promise<LockedBalance> {
  const existing = await lockBalance(tx, shelf.variantId, shelf.locationId);
  if (existing) return existing;

  await insertZeroBalance(tx, {
    variantId: shelf.variantId,
    locationId: shelf.locationId,
    updatedAt: recordedAt,
  });

  const created = await lockBalance(tx, shelf.variantId, shelf.locationId);
  // Unreachable: the row was either inserted here or by a writer that committed
  // before this one, and balance rows are never deleted.
  if (!created) {
    throw new AppError(
      'INTERNAL',
      `Balance for variant ${shelf.variantId} at location ${shelf.locationId} ` +
        'vanished within its own transaction',
    );
  }
  return created;
}

/**
 * One movement is reversed at most once (INV-2).
 *
 * A `409` rather than a silent success: the correction the caller asked for has
 * already been made, and answering "done" would let a screen believe it had
 * just posted a second one. The existing reversal is named when it is known, so
 * whoever is looking can go and read it.
 */
function alreadyReversed(originalId: string, reversalId: string | null): AppError {
  return conflict(
    `Movement ${originalId} has already been reversed` +
      (reversalId ? ` by movement ${reversalId}` : '') +
      '. A movement is reversed once; post a new movement if the stock changed again.',
  );
}

/** Everything about a command that can be judged without touching the database. */
function validateCommand(command: PostMovementCommand): void {
  const details: { path: string; message: string }[] = [];

  const movementType = movementTypeSchema.safeParse(command.movementType);
  if (!movementType.success) {
    details.push({
      path: 'movementType',
      message: `Unknown movement type: ${String(command.movementType)}`,
    });
    // Nothing below can be judged without knowing the type.
    throw validationFailed(details);
  }

  // Reversal is a different shape of command: it derives its delta from the
  // movement it reverses and must set `reverses_movement_id`. The type
  // signature already excludes it; this catches an untyped caller.
  if (movementType.data === 'REVERSAL') {
    throw new AppError(
      'INTERNAL',
      'Reversal posting is not implemented. This engine posts normal movements only; ' +
        'REVERSAL arrives with the reversal workflow.',
    );
  }

  const quantityDelta = quantityDeltaSchema.safeParse(command.quantityDelta);
  if (!quantityDelta.success) {
    details.push({
      path: 'quantityDelta',
      message: 'quantity_delta must be a non-zero integer in whole base units',
    });
  } else {
    const required = REQUIRED_DELTA_SIGN[movementType.data];
    if (required === 'positive' && quantityDelta.data < 0) {
      details.push({
        path: 'quantityDelta',
        message: `${movementType.data} adds stock and requires a positive quantity_delta`,
      });
    }
    if (required === 'negative' && quantityDelta.data > 0) {
      details.push({
        path: 'quantityDelta',
        message: `${movementType.data} removes stock and requires a negative quantity_delta`,
      });
    }
  }

  // An adjustment is a human overriding the ledger's own arithmetic, and an
  // issue is stock leaving for a reason that *is* the business fact — sold,
  // broken, and consumed are three different things. Both say why (INV-11). A
  // blank reason is a missing reason.
  if (REASON_REQUIRED_MOVEMENT_TYPES.includes(movementType.data)) {
    if (command.reasonCode === null || command.reasonCode.trim().length === 0) {
      details.push({
        path: 'reasonCode',
        message: `${movementType.data} requires a reason code`,
      });
    }
  }

  if (details.length > 0) throw validationFailed(details);
}

function validationFailed(details: { path: string; message: string }[]): AppError {
  return new AppError('VALIDATION_FAILED', 'Movement validation failed', details);
}
