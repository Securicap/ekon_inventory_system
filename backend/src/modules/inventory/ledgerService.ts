import {
  movementTypeSchema,
  quantityDeltaSchema,
  REASON_REQUIRED_MOVEMENT_TYPES,
  type MovementType,
} from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import {
  claimOperation,
  completeOperation,
  getMovementById,
  getOperation,
  insertMovement,
  insertZeroBalance,
  lockBalance,
  MOVEMENT_RESULT_RESOURCE_TYPE,
  updateBalance,
  type LockedBalance,
  type PostedMovement,
} from './infrastructure/ledgerRepository.js';

/**
 * The posting engine: the one trusted path that puts a movement in the ledger.
 *
 * It is internal on purpose. Nothing HTTP reaches it — there is no route, no
 * request schema, and no receiving, adjustment, count, or reversal workflow.
 * Those workflows are thin callers that will be built on top of this, and each
 * arrives with its own PR. What exists here is the atomic step they all share:
 * claim the operation, lock the balance, derive the quantities, append one
 * movement, move the projection, record the result — all in one transaction, or
 * none of it (INV-5).
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
}

export interface LedgerServiceDeps {
  pool: DatabasePool;
  /** Stamps the operation, the movement, and the balance. Never `new Date()`. */
  clock: Clock;
  /** Mints movement ids. Defaults to the application's UUIDv7 generator. */
  generateId?: () => string;
}

export interface LedgerService {
  postMovement(command: PostMovementCommand): Promise<PostedMovement>;
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
    ADJUSTMENT_IN: 'positive',
    ADJUSTMENT_OUT: 'negative',
    // A count reconciles to what is physically on the shelf, which can be more
    // or less than the system believed.
    COUNT_RECONCILIATION: 'any',
  };

export function createLedgerService(deps: LedgerServiceDeps): LedgerService {
  const generateId = deps.generateId ?? newId;

  async function postMovement(command: PostMovementCommand): Promise<PostedMovement> {
    // Everything that can be judged without reading the database is judged
    // first, so a malformed command never opens a transaction.
    validateCommand(command);

    return withTransaction(deps.pool, async (tx) => {
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

      await completeOperation(tx, { id: command.operationId, movementId: movement.id });

      return movement;
    });
  }

  return { postMovement };
}

/**
 * Answers a command whose operation id was already used.
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
  command: PostMovementCommand,
): Promise<PostedMovement> {
  const existing = await getOperation(tx, command.operationId);

  // Unreachable in practice: the claim failed because a committed row exists,
  // and operations are never deleted. Guarded rather than assumed.
  if (!existing) {
    throw new AppError(
      'INTERNAL',
      `Operation ${command.operationId} could not be claimed and could not be loaded`,
    );
  }

  if (existing.operationType !== command.operationType) {
    throw replayedWithDifferentRequest(
      command.operationId,
      `operation type ${existing.operationType} does not match ${command.operationType}`,
    );
  }

  if (existing.requestHash !== command.requestHash) {
    throw replayedWithDifferentRequest(
      command.operationId,
      'request hash does not match the original request',
    );
  }

  // The operation matches, so the original attempt must have recorded which
  // movement it produced. If it did not, something outside this engine wrote
  // that row, and posting a second movement would silently double the stock.
  // Refusing is the safe answer.
  if (
    existing.resultResourceType !== MOVEMENT_RESULT_RESOURCE_TYPE ||
    existing.resultResourceId === null
  ) {
    throw new AppError(
      'INTERNAL',
      `Operation ${command.operationId} was already claimed but records no inventory movement ` +
        'result. Refusing to post a second movement.',
    );
  }

  const movement = await getMovementById(tx, existing.resultResourceId);
  if (!movement) {
    throw new AppError(
      'INTERNAL',
      `Operation ${command.operationId} points at movement ${existing.resultResourceId}, ` +
        'which does not exist. Refusing to post a second movement.',
    );
  }

  // The movement must be the one this operation produced. A pointer at some
  // other operation's movement means the operations row is wrong, and returning
  // that movement would report a stock change this command never made.
  if (movement.operationId !== command.operationId) {
    throw new AppError(
      'INTERNAL',
      `Operation ${command.operationId} points at movement ${movement.id}, which was posted ` +
        `by operation ${movement.operationId}. Refusing to return another operation's movement ` +
        'or to post a second one.',
    );
  }

  return movement;
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
  command: PostMovementCommand,
  recordedAt: Date,
): Promise<LockedBalance> {
  const existing = await lockBalance(tx, command.variantId, command.locationId);
  if (existing) return existing;

  await insertZeroBalance(tx, {
    variantId: command.variantId,
    locationId: command.locationId,
    updatedAt: recordedAt,
  });

  const created = await lockBalance(tx, command.variantId, command.locationId);
  // Unreachable: the row was either inserted here or by a writer that committed
  // before this one, and balance rows are never deleted.
  if (!created) {
    throw new AppError(
      'INTERNAL',
      `Balance for variant ${command.variantId} at location ${command.locationId} ` +
        'vanished within its own transaction',
    );
  }
  return created;
}

function replayedWithDifferentRequest(operationId: string, detail: string): AppError {
  return new AppError(
    'OPERATION_REPLAYED_WITH_DIFFERENT_BODY',
    `Operation ${operationId} was already used for a different request: ${detail}`,
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

  // An adjustment is a human overriding the ledger's own arithmetic, so it says
  // why (INV-11). A blank reason is a missing reason.
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
