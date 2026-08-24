import type {
  CountPage,
  CountQuery,
  CountRecord,
  RecordCountRequest,
  ReconcileCountRequest,
} from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError, conflict, notFound } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import type { CatalogService, VariantLabel } from '../catalog/index.js';
import type { IdentityUserService } from '../identity/index.js';
import {
  COUNT_RECONCILE_OPERATION_TYPE,
  countReconciliationRequestHash,
} from './domain/countReconciliationRequestHash.js';
import { COUNT_RECORD_OPERATION_TYPE, countRequestHash } from './domain/countRequestHash.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './domain/historyCursor.js';
import { lockShelfQuantity } from './infrastructure/balanceRepository.js';
import {
  COUNT_RESULT_RESOURCE_TYPE,
  getCountLineById,
  insertCountLine,
  listCountLines,
  lockCountLine,
  reconcileCountLine,
  type CountLine,
} from './infrastructure/countRepository.js';
import { findLocationForStock, findLocationLabels } from './infrastructure/locationRepository.js';
import {
  assertOperationMatchesClaim,
  claimOperation,
  completeOperation,
  getOperation,
} from './infrastructure/operationRepository.js';
import type { LedgerService, OperationClaim } from './ledgerService.js';

/**
 * Physical counts: what somebody saw on a shelf, and what the shop decided
 * about the difference.
 *
 * ```text
 * SYSTEM EXPECTED  +  PHYSICAL OBSERVATION
 *            ↓
 *        DISCREPANCY
 *            ↓
 *      INVESTIGATION
 *            ↓
 * RECONCILIATION DECISION
 *            ↓
 * COUNT_RECONCILIATION movement, if the variance is not zero
 * ```
 *
 * **A count observes. Investigation explains. Reconciliation changes stock.**
 * Those are three acts and this service keeps them three. `recordCount` writes
 * one row and touches neither `inventory_movements` nor `inventory_balances`;
 * `reconcileCount` is the only thing here that moves stock, and it only ever
 * does so because somebody asked it to and said why.
 *
 * The temptation this file exists to refuse is the one-line version: *counted
 * six, so set the balance to six*. That erases the only signal the shop had.
 * Six may be six because a customer bought one and nobody rang it up, because
 * one broke, because a delivery was never entered, because somebody mis-keyed a
 * receipt, because the last one is on another shelf, or because it was stolen —
 * and those are not the same event. A system that flattens them into an
 * overwrite cannot tell a shop it is being stolen from.
 *
 * **This is not a stocktake platform.** One observation covers one variant at
 * one location. There are no sessions, no campaigns, no blind counts, no second
 * counts, no thresholds, and no approval queue — and nothing here is shaped so
 * that adding one later would be easy, because easy is how they arrive.
 */

export interface RecordCountCommand {
  /** The parsed request body — exactly what a caller is allowed to state. */
  request: RecordCountRequest;
  /** `request.actor.id`, from the session cookie. Never a value off the wire. */
  actorId: string;
}

export interface ReconcileCountCommand {
  /** From the path, parsed with the shared schema like any other input. */
  countId: string;
  request: ReconcileCountRequest;
  actorId: string;
}

export interface CountServiceDeps {
  pool: DatabasePool;
  /** Stamps the operation and the observation. Never `new Date()`. */
  clock: Clock;
  /**
   * The one trusted path into the ledger. Reconciliation posts through it and
   * **inside this service's transaction**, so the movement and the settled
   * count commit together — see `reconcileCount`.
   */
  ledger: Pick<LedgerService, 'postMovementInTransaction' | 'findCompletedMovement'>;
  /**
   * The catalog, narrowed to the two questions counting has: may this
   * merchandise be counted, and what is it called?
   *
   * `findVariantForCounting` and not the issue or correction question. They
   * happen to agree today; they are different questions, and a workflow given
   * only its own cannot start answering with somebody else's rule.
   */
  catalog: Pick<CatalogService, 'findVariantForCounting' | 'findVariantLabels'>;
  /** Identity, narrowed to a bulk display-name lookup. Counts never read `users`. */
  identity: Pick<IdentityUserService, 'findUserDisplayNames'>;
  /** Mints count ids. Defaults to the application's UUIDv7 generator. */
  generateId?: () => string;
}

export interface CountService {
  recordCount(command: RecordCountCommand): Promise<CountRecord>;
  listCounts(query: CountQuery): Promise<CountPage>;
  reconcileCount(command: ReconcileCountCommand): Promise<CountRecord>;
}

export function createCountService(deps: CountServiceDeps): CountService {
  const generateId = deps.generateId ?? newId;

  /**
   * Records what somebody physically observed. **It changes no stock.**
   *
   * One transaction covers the claim, the eligibility checks, the expected
   * quantity, the insert, and the operation's result pointer — not because a
   * count is dangerous, but because the expected quantity is only evidence if
   * it was true at a moment this row can be said to belong to. Reading a
   * balance on one connection and inserting the observation on another would
   * record a number that was true at neither.
   *
   * The shelf is locked `FOR SHARE` for the milliseconds this takes and not one
   * moment longer. **There is no count mode**: sales and receipts continue
   * against a counted shelf while somebody investigates the variance, which is
   * exactly why reconciliation later applies the observed *difference* rather
   * than setting the balance to what was counted.
   */
  async function recordCount({ request, actorId }: RecordCountCommand): Promise<CountRecord> {
    // The wire carries a string; everything downstream works in instants. One
    // conversion, here, so the hash and the row agree on what time it was.
    const countedAt = new Date(request.countedAt);

    const claim: OperationClaim = {
      operationId: request.operationId,
      operationType: COUNT_RECORD_OPERATION_TYPE,
      requestHash: countRequestHash({
        variantId: request.variantId,
        locationId: request.locationId,
        countedQuantity: request.countedQuantity,
        countedAt,
        actorId,
      }),
    };

    /**
     * Settled first, present tense second — the rule every command in this
     * module follows, and counting sharpens it.
     *
     * A retry of an observation that already recorded is a question about the
     * past, and the answer must not depend on what happened afterwards: not to
     * the merchandise, and — the case unique to counts — **not to the shelf**.
     * Re-running the recording path would read today's balance and produce a
     * different expected quantity, so a retry after a receipt landed would
     * either duplicate the observation with different arithmetic or refuse a
     * command that had already succeeded. Answering from the stored row is what
     * makes a count line the same fact however many times its command arrives.
     */
    const settled = await findRecordedCount(deps.pool, claim);
    if (settled) return toRecord(await label([settled]), settled);

    const line = await withTransaction(deps.pool, async (tx) => {
      const recordedAt = deps.clock.now();

      const claimed = await claimOperation(tx, {
        id: claim.operationId,
        operationType: claim.operationType,
        requestHash: claim.requestHash,
        createdAt: recordedAt,
      });
      if (!claimed) return replayRecordedCount(tx, claim);

      // Eligibility inside the transaction, because both answers have to still
      // be true when the row is written. The catalog locks the merchandise rows
      // while it answers, exactly as it does for a posting workflow.
      await assertVariantIsCountable(tx, request.variantId);
      await assertLocationIsCountable(tx, request.locationId);

      /**
       * The expected quantity, and the whole of INV-9's server-owned half.
       *
       * Read from the balance projection under a shared lock, so nothing can
       * move this shelf between reading it and writing the observation. **An
       * absent balance row is zero** and is left absent: a shelf that has never
       * held stock expects nothing, and a read has no business creating a row
       * to say so. Only a reconciliation that actually moves stock brings one
       * into existence.
       */
      const expectedQuantity = await lockShelfQuantity(tx, request.variantId, request.locationId);

      const inserted = await insertCountLine(tx, {
        id: generateId(),
        variantId: request.variantId,
        locationId: request.locationId,
        expectedQuantity,
        countedQuantity: request.countedQuantity,
        countedByUserId: actorId,
        countedAt,
        recordedAt,
        operationId: claim.operationId,
      });

      await completeOperation(tx, {
        id: claim.operationId,
        resultResourceType: COUNT_RESULT_RESOURCE_TYPE,
        resultResourceId: inserted.id,
      });

      return inserted;
    });

    return toRecord(await label([line]), line);
  }

  /**
   * Accepts a discrepancy: *this observation is the correct shelf quantity, and
   * here is why the difference is real*.
   *
   * **One transaction, and it is the point of the whole design.** The
   * reconciliation movement and the settled count commit together or neither
   * commits. A count marked reconciled with no movement behind it is a stock
   * change the shop believes happened and did not; a movement whose count still
   * reads unresolved is a stock change nobody can explain. The ledger is
   * therefore entered through `postMovementInTransaction`, which is the same
   * posting algorithm every other workflow uses, joined to this unit of work
   * instead of opening one of its own (INV-5).
   *
   * The order inside it:
   *
   *  1. **lock the count** — this is what makes "still unresolved?" a decision
   *     rather than a guess, and it is what two people accepting the same
   *     variance at once queue behind;
   *  2. answer this very command if it already settled the count, and refuse
   *     any other command that finds it settled;
   *  3. post the movement — the ledger claims the operation, checks the
   *     lifecycle under its own lock, locks the balance, enforces the stock
   *     floor, appends, and moves the projection;
   *  4. write the decision onto the count, pointing at that movement.
   *
   * If step 3 refuses — because the shelf can no longer absorb the variance —
   * step 4 never runs and the count stays `OPEN`, which is the honest outcome:
   * the discrepancy is still unexplained and now demonstrably needs somebody to
   * look at the movements posted since.
   */
  async function reconcileCount({
    countId,
    request,
    actorId,
  }: ReconcileCountCommand): Promise<CountRecord> {
    const note = request.note ?? null;

    const claim: OperationClaim = {
      operationId: request.operationId,
      operationType: COUNT_RECONCILE_OPERATION_TYPE,
      requestHash: countReconciliationRequestHash({
        countId,
        reason: request.reason,
        note,
        actorId,
      }),
    };

    // Settled first: a retry of a decision that already posted is answered from
    // the count itself, so the second attempt neither posts again nor is told
    // its own work conflicts with it.
    const settled = await findSettledReconciliation(deps.pool, claim, countId);
    if (settled) return toRecord(await label([settled]), settled);

    const line = await withTransaction(deps.pool, async (tx) => {
      const locked = await lockCountLine(tx, countId);
      if (!locked) throw notFound('Physical count');

      if (locked.status !== 'OPEN') return alreadySettled(tx, locked, claim);

      const movement = await deps.ledger.postMovementInTransaction(tx, {
        ...claim,
        variantId: locked.variantId,
        locationId: locked.locationId,
        movementType: 'COUNT_RECONCILIATION',
        /**
         * The delta, from the count and from nowhere else.
         *
         * `counted - expected`, as the database computed it when the
         * observation was recorded — **not** `counted - current balance`. The
         * difference is the whole count principle: what is being accepted is
         * the discrepancy somebody physically observed, and applying it to the
         * current balance is what keeps every legitimate movement posted since
         * the count. Seven expected, six counted, one sold in between: the
         * shelf ends at five, because five is what is actually there.
         */
        quantityDelta: locked.variance,
        // The accepted-discrepancy reason becomes the ledger's reason code,
        // unchanged and untranslated. 0013 makes the database require one for
        // this movement type, so an unexplained reconciliation cannot be
        // written by any path.
        reasonCode: request.reason,
        note,
        userId: actorId,
        /**
         * Business time is the count's own.
         *
         * The discrepancy existed when the shelf was walked; accepting it a day
         * later is a decision about that past observation, not a new event on
         * the shelf. Using the reconciler's wall clock would put the ledger's
         * account of when the stock differed at the moment somebody got round
         * to the paperwork — and `occurred_at` is business time precisely so
         * that it does not have to be. `recorded_at` remains the ledger's own,
         * sampled inside the posting transaction.
         */
        occurredAt: locked.countedAt,
        precondition: assertVariantIsCountablePrecondition(locked.variantId),
      });

      return reconcileCountLine(tx, {
        id: locked.id,
        reason: request.reason,
        note,
        reconciledByUserId: actorId,
        // The same instant the movement carries, so the two rows cannot
        // disagree about when the decision was recorded.
        reconciledAt: movement.recordedAt,
        reconciliationOperationId: claim.operationId,
        reconciliationMovementId: movement.id,
      });
    });

    return toRecord(await label([line]), line);
  }

  /**
   * One page of count evidence, newest recorded first.
   *
   * **Four bounded statements for a page of any size**, and one when the page is
   * empty: the count lines, then the variant labels (two inside the catalog),
   * the location labels, and the display names — each asked once, in bulk, for
   * the ids the page actually refers to. There is no query per row.
   *
   * The page is read as `limit + 1` rows so `nextCursor` is null exactly on the
   * last page rather than one page late, which is PR 4's technique and its
   * reasoning.
   */
  async function listCounts(query: CountQuery): Promise<CountPage> {
    const lines = await listCountLines(deps.pool, {
      status: query.status,
      variantId: query.variantId,
      locationId: query.locationId,
      recordedFrom: query.recordedFrom === undefined ? undefined : new Date(query.recordedFrom),
      recordedTo: query.recordedTo === undefined ? undefined : new Date(query.recordedTo),
      after: query.cursor === undefined ? undefined : decodeHistoryCursor(query.cursor),
      limit: query.limit + 1,
    });

    if (lines.length === 0) return { items: [], nextCursor: null };

    const hasMore = lines.length > query.limit;
    const page = hasMore ? lines.slice(0, query.limit) : lines;
    const labels = await label(page);
    const last = page[page.length - 1];

    return {
      items: page.map((line) => toRecord(labels, line)),
      nextCursor:
        hasMore && last
          ? encodeHistoryCursor({ recordedAt: last.recordedAtExact, id: last.id })
          : null,
    };
  }

  /**
   * May this merchandise be counted, right now, in this transaction?
   *
   * The catalog's answer, read under its lock. `ACTIVE` and `DISCONTINUED` both
   * pass — discontinued stock is real stock on a real shelf, and a stocktake
   * that skipped it would be counting some of the shop's inventory and calling
   * it all of it. `ARCHIVED` does not: archiving asserts the merchandise holds
   * nothing anywhere, so there is nothing to count.
   */
  async function assertVariantIsCountable(tx: DatabaseClient, variantId: string): Promise<void> {
    const variant = await deps.catalog.findVariantForCounting(tx, variantId);
    if (!variant) throw notFound('Product variant');
    if (!variant.permitted) {
      throw conflict(
        `This product variant is ${variant.lifecycleStatus} and cannot be counted. ` +
          'Restore it to DISCONTINUED first if it genuinely holds stock.',
      );
    }
  }

  /** The same check, in the shape the posting engine runs preconditions in. */
  function assertVariantIsCountablePrecondition(variantId: string) {
    return (tx: DatabaseClient): Promise<void> => assertVariantIsCountable(tx, variantId);
  }

  /**
   * A count is recorded against a shelf that is open for business.
   *
   * Deliberately **not** re-checked when a discrepancy is reconciled later. The
   * observation was made while the shelf was open; refusing to settle it
   * because the shop has since closed that location would leave the discrepancy
   * permanently unresolvable for a reason that has nothing to do with it — the
   * same rule reversal follows, and for the same reason. Closing a shelf is an
   * operational decision about the future, not a veto on finishing what was
   * already started.
   */
  async function assertLocationIsCountable(tx: DatabaseClient, locationId: string): Promise<void> {
    const location = await findLocationForStock(tx, locationId);
    if (!location) throw notFound('Inventory location');
    if (!location.isActive) {
      throw conflict('This inventory location is no longer active and cannot be counted');
    }
  }

  /**
   * Answers a reconcile command that finds the count already settled.
   *
   * Two different situations arrive here and they get opposite answers:
   *
   * **This very command settled it.** A retry that queued behind its own
   * in-flight first attempt — the pre-transaction lookup found nothing because
   * that attempt had not committed yet. It is answered with the count, exactly
   * as the pre-transaction path would have answered it a moment later. The
   * operation is compared against the claim first, so a second command reusing
   * one id with a different reason is still refused rather than handed somebody
   * else's decision.
   *
   * **Something else settled it.** A `409`, naming what the count already is: a
   * `MATCHED` count needs no acceptance because the shelf agreed, and a
   * `RECONCILED` one has an accepted reason and a movement behind it already.
   * Posting a second movement for one discrepancy would move the shelf twice
   * for a difference that was observed once.
   */
  async function alreadySettled(
    tx: DatabaseClient,
    line: CountLine,
    claim: OperationClaim,
  ): Promise<CountLine> {
    if (line.reconciliationOperationId === claim.operationId) {
      const existing = await getOperation(tx, claim.operationId);
      // Unreachable: the count names this operation, so its row exists.
      if (!existing) {
        throw new AppError(
          'INTERNAL',
          `Count ${line.id} names operation ${claim.operationId}, which does not exist.`,
        );
      }
      assertOperationMatchesClaim(existing, claim);
      return line;
    }

    if (line.status === 'MATCHED') {
      throw conflict(
        `This count matched: ${line.countedQuantity} counted, ${line.countedQuantity} expected. ` +
          'There is no discrepancy to accept, and nothing to post.',
      );
    }

    throw conflict(
      `This count was already reconciled as ${String(line.reconciliationReason)}, ` +
        `and movement ${String(line.reconciliationMovementId)} carried it. ` +
        'A discrepancy is accepted once; to undo its effect on stock, reverse that movement.',
    );
  }

  /** Bulk labels for a page of counts. See {@link toRecord} for what they are not. */
  async function label(lines: CountLine[]): Promise<CountLabels> {
    const actorIds = unique([
      ...lines.map((line) => line.countedByUserId),
      ...lines.flatMap((line) => (line.reconciledByUserId ? [line.reconciledByUserId] : [])),
    ]);

    const [variants, locations, actors] = await Promise.all([
      deps.catalog.findVariantLabels(unique(lines.map((line) => line.variantId))),
      findLocationLabels(deps.pool, unique(lines.map((line) => line.locationId))),
      deps.identity.findUserDisplayNames(actorIds),
    ]);

    return {
      variants: new Map(variants.map((variant) => [variant.id, variant])),
      locations: new Map(locations.map((location) => [location.id, location.name])),
      names: new Map(actors.map((actor) => [actor.id, actor.displayName])),
    };
  }

  return { recordCount, listCounts, reconcileCount };
}

interface CountLabels {
  variants: Map<string, VariantLabel>;
  locations: Map<string, string>;
  names: Map<string, string>;
}

/**
 * A count line, labelled.
 *
 * **The three numbers come back exactly as they were stored.** Nothing here
 * compares the count against today's balance, and nothing recomputes the
 * variance — a read that did would rewrite the evidence every time the shop
 * traded, and what the counter actually saw would be gone.
 *
 * **The labels are current, not historical.** The count stores ids, quantities,
 * timestamps and decisions; the product name, the brand, the location name and
 * the people's names are resolved from the tables that own them today. Renaming
 * a product changes what an old count *displays* while the count still refers to
 * the same immutable variant id and SKU. The same rule PR 4 states for movement
 * history, and it is not a compromise — storing a name would be claiming the
 * count knows what the merchandise was called, which it does not.
 *
 * Merchandise the shop has since archived and shelves it has since closed
 * resolve normally: evidence is not filtered by present-tense operational
 * status.
 */
function toRecord(labels: CountLabels, line: CountLine): CountRecord {
  const variant = labels.variants.get(line.variantId);

  return {
    id: line.id,
    variant: variant
      ? {
          id: variant.id,
          productId: variant.productId,
          productName: variant.productName,
          brandName: variant.brandName,
          sku: variant.sku,
          attributes: variant.attributes,
        }
      : unresolvedVariant(line.variantId),
    location: {
      id: line.locationId,
      name: labels.locations.get(line.locationId) ?? UNRESOLVED,
    },
    expectedQuantity: line.expectedQuantity,
    countedQuantity: line.countedQuantity,
    variance: line.variance,
    countedAt: line.countedAt.toISOString(),
    recordedAt: line.recordedAt.toISOString(),
    counter: {
      id: line.countedByUserId,
      displayName: labels.names.get(line.countedByUserId) ?? null,
    },
    status: line.status,
    reconciliation: toReconciliation(labels, line),
  };
}

/**
 * The decision, when there is one.
 *
 * Every field is read from the row rather than assembled from what the caller
 * asked for, and the database has already guaranteed the set is complete: a
 * reconciliation is four columns and a movement, all set together or all absent
 * (0013). The `null` fallbacks below therefore describe a state the schema
 * forbids, and exist so a defect surfaces as a missing label rather than as a
 * crash in a read.
 */
function toReconciliation(labels: CountLabels, line: CountLine): CountRecord['reconciliation'] {
  if (
    line.reconciliationReason === null ||
    line.reconciledAt === null ||
    line.reconciledByUserId === null ||
    line.reconciliationMovementId === null
  ) {
    return null;
  }

  return {
    reason: line.reconciliationReason,
    note: line.reconciliationNote,
    reconciledAt: line.reconciledAt.toISOString(),
    actor: {
      id: line.reconciledByUserId,
      displayName: labels.names.get(line.reconciledByUserId) ?? null,
    },
    movementId: line.reconciliationMovementId,
  };
}

/**
 * Reads what a count-recording operation already produced, on the pool.
 *
 * The count counterpart of the ledger's `findCompletedMovement`, and it
 * necessarily is one: an operation's result is a movement or a count line, and
 * only the workflow that claimed it knows which to expect. A claimed operation
 * with no result yet returns `null` — an uncommitted attempt is not an answer
 * to anybody, and the transactional claim remains the only thing that decides
 * who owns the command.
 */
async function findRecordedCount(
  db: DatabasePool | DatabaseClient,
  claim: OperationClaim,
): Promise<CountLine | null> {
  const existing = await getOperation(db, claim.operationId);
  if (!existing) return null;

  assertOperationMatchesClaim(existing, claim);

  if (existing.resultResourceType !== COUNT_RESULT_RESOURCE_TYPE || !existing.resultResourceId) {
    return null;
  }

  const line = await getCountLineById(db, existing.resultResourceId);
  if (!line) {
    throw new AppError(
      'INTERNAL',
      `Operation ${claim.operationId} points at count ${existing.resultResourceId}, ` +
        'which does not exist. Refusing to record a second observation.',
    );
  }
  return line;
}

/**
 * Answers a recording command whose operation id was already claimed, from
 * inside the transaction whose claim just lost.
 *
 * A genuine retry returns the observation the first attempt recorded. A claim
 * that conflicted with a committed row that records no result is refused rather
 * than guessed at: recording a second observation would leave two accounts of
 * one shelf-check, either of which somebody could reconcile.
 */
async function replayRecordedCount(tx: DatabaseClient, claim: OperationClaim): Promise<CountLine> {
  const line = await findRecordedCount(tx, claim);
  if (line) return line;

  throw new AppError(
    'INTERNAL',
    `Operation ${claim.operationId} was already claimed but records no count. ` +
      'Refusing to record a second observation.',
  );
}

/**
 * Reads what a reconcile operation already produced, on the pool.
 *
 * The operation's result pointer is the *movement*, because the ledger recorded
 * it — so the count is found by its id from the path and then checked to be the
 * one this operation settled. That check is a guard rather than a filter: the
 * request hash covers the count id, so a matching operation that settled a
 * different count would mean two commands hashed alike, and answering with
 * either count would be answering the wrong question.
 */
async function findSettledReconciliation(
  db: DatabasePool | DatabaseClient,
  claim: OperationClaim,
  countId: string,
): Promise<CountLine | null> {
  const existing = await getOperation(db, claim.operationId);
  if (!existing) return null;

  assertOperationMatchesClaim(existing, claim);

  const line = await getCountLineById(db, countId);
  if (!line || line.reconciliationOperationId !== claim.operationId) return null;
  return line;
}

/** What is shown when a permanent id names nothing. Never a blank, never a guess. */
const UNRESOLVED = 'Unknown';

function unresolvedVariant(variantId: string): CountRecord['variant'] {
  return {
    id: variantId,
    productId: variantId,
    productName: UNRESOLVED,
    brandName: null,
    sku: 'EKN-00000000',
    attributes: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
