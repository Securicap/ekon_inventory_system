import type { AdjustStockRequest, AdjustStockResponse } from '@ekon/shared';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { conflict, notFound } from '../../platform/http/errors.js';
import type { CatalogService } from '../catalog/index.js';
import {
  ADJUSTMENT_OPERATION_TYPE,
  adjustmentRequestHash,
} from './domain/adjustmentRequestHash.js';
import type { PostedMovement } from './infrastructure/ledgerRepository.js';
import { findLocationForStock } from './infrastructure/locationRepository.js';
import type { LedgerService, OperationClaim, PostableMovementType } from './ledgerService.js';

/**
 * Stock adjustment: correcting a recorded quantity that was wrong.
 *
 * **This is not a removal, and it is not a receipt.** A `RECEIPT` says stock
 * arrived and an `ISSUE` says stock left; an adjustment says nothing physical
 * happened at all — the number was wrong. They look identical in a balance and
 * mean opposite things in a history, and this ledger is append-only, so a
 * movement written under the wrong one of them is wrong forever. That is why
 * they are separate movement types under separate capabilities, and why
 * `inventory.adjust` is deliberately not granted alongside `inventory.remove`:
 * recording that stock left is the job at the counter, and making a shortfall
 * disappear is authority over the records themselves.
 *
 * **This is not a reversal.** When the wrong movement is known, reversing it
 * links the mistake to its remedy and derives the quantity from the row
 * (`reversalService.ts`). An adjustment is what is left when there is no single
 * movement to point at — a receipt nobody entered, a quantity mistyped weeks
 * ago and found now, units on a shelf with no history behind them.
 *
 * **This is not a physical count.** A count observes reality and reconciles
 * through a `COUNT_RECONCILIATION` that records what was expected and what was
 * seen (INV-9). Adjusting a balance to match a count would destroy the
 * variance, which is the only signal the shop had that something is wrong.
 * Counts are PR 6's, and nothing here anticipates them.
 *
 * Like receiving and removal it is a thin caller. Everything about *how* a
 * movement is written — the id, the recorded time, the before and after
 * quantities, the chain pointer, the row lock, the operation claim, the replay,
 * and the stock floor — belongs to the posting engine and is not repeated,
 * wrapped, or second-guessed here. What this file owns is the five things the
 * engine cannot know:
 *
 *  1. that the location is real, and that the merchandise may still be
 *     corrected at the moment the movement is written;
 *  2. what the canonical business command *was*, so a retry can be recognized;
 *  3. that the **sign of the delta** decides the movement type, and that the
 *     request never states one;
 *  4. that the caller's business reason and note become the ledger's;
 *  5. what the caller is told afterwards.
 */

/**
 * One adjustment command: what the caller stated, and who they turned out to be.
 *
 * The actor is a separate field rather than a property of the request, because
 * it did not come from the request. It comes from the session the enforcement
 * hook resolved, and keeping the two apart in the type is what makes a body
 * that tries to supply a user id obviously wrong rather than merely rejected
 * somewhere else.
 */
export interface AdjustStockCommand {
  /** The parsed request body — exactly what a caller is allowed to state. */
  request: AdjustStockRequest;
  /** `request.actor.id`, from the session cookie. Never a value off the wire. */
  actorId: string;
}

export interface AdjustmentServiceDeps {
  pool: DatabasePool;
  /** The one trusted path into the ledger. Adjustment never writes directly. */
  ledger: LedgerService;
  /**
   * The catalog's application service, narrowed to the one question this
   * workflow has: may this merchandise's record be corrected?
   *
   * Deliberately **not** the receiving or issue question. A correction is about
   * ledger truth rather than about trade, so discontinuing merchandise must
   * never make its history uncorrectable — a shop that stops reordering an item
   * on Friday still has to be able to fix Thursday's mis-keyed receipt.
   */
  catalog: Pick<CatalogService, 'findVariantForCorrection'>;
}

export interface AdjustmentService {
  adjustStock(command: AdjustStockCommand): Promise<AdjustStockResponse>;
}

export function createAdjustmentService(deps: AdjustmentServiceDeps): AdjustmentService {
  async function adjustStock({
    request,
    actorId,
  }: AdjustStockCommand): Promise<AdjustStockResponse> {
    // The wire carries a string; everything downstream works in instants. One
    // conversion, here, so the hash and the ledger agree on what time it was —
    // `10:00-05:00` and `15:00Z` are the same correction and must hash alike.
    const occurredAt = new Date(request.occurredAt);
    const note = request.note ?? null;

    const claim: OperationClaim = {
      operationId: request.operationId,
      operationType: ADJUSTMENT_OPERATION_TYPE,
      // The server's digest of the server's canonical form. No client submits a
      // request hash: one that could would decide for itself whether its own
      // retry counted as the same command.
      requestHash: adjustmentRequestHash({
        variantId: request.variantId,
        locationId: request.locationId,
        quantityDelta: request.quantityDelta,
        reason: request.reason,
        note,
        occurredAt,
        actorId,
      }),
    };

    /**
     * Settled first, present tense second — the same rule receiving and removal
     * follow, and it matters here for the same reason.
     *
     * A retry of a correction that already posted is a question about the past.
     * Merchandise archived that evening must not make the afternoon's
     * correction unanswerable, and a client that never received the first
     * response would otherwise retry forever into a `409` for a movement the
     * ledger already holds.
     *
     * A mismatched hash raises `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` from
     * inside that lookup, which is the right answer and the right order: one
     * operation id used for two different commands is a conflict about the id,
     * not a fact about the merchandise.
     */
    const alreadyPosted = await deps.ledger.findCompletedMovement(claim);
    if (alreadyPosted) return toResult(alreadyPosted);

    await assertLocationIsStockable(request.locationId);

    const movement = await deps.ledger.postMovement({
      ...claim,
      variantId: request.variantId,
      locationId: request.locationId,
      /**
       * The one place the movement type is decided, and it is decided from the
       * sign rather than from anything the caller wrote.
       *
       * A request that could name the type could post an `ADJUSTMENT_IN` that
       * removed stock, and the ledger would be permanently wrong in a way no
       * reversal can un-say — the row would read as an increase forever. The
       * engine additionally refuses a type whose sign disagrees with its delta,
       * so this derivation is checked rather than trusted.
       */
      movementType: adjustmentTypeFor(request.quantityDelta),
      // Stated by the caller, signed, and passed through unchanged. This is the
      // only workflow where that is true, and it is why the contract is the one
      // that carries a sign.
      quantityDelta: request.quantityDelta,
      // The business reason becomes the ledger's reason code, unchanged and
      // untranslated. Required for both adjustment types by CHECK (INV-11), and
      // the reason an adjustment is not an unexplained edit.
      reasonCode: request.reason,
      note,
      userId: actorId,
      occurredAt,
      precondition: assertMayCorrect(request.variantId),
    });

    // Whichever way the engine answered — a fresh post, or a replay resolved by
    // its own transactional claim when a concurrent attempt got there first —
    // the result is read off the persisted row rather than the values this
    // service sent in.
    return toResult(movement);
  }

  /**
   * The lifecycle rule, as a check the posting engine runs inside its own
   * transaction — where the catalog locks the merchandise rows, so a lifecycle
   * change and this correction cannot cross unnoticed.
   *
   * `ACTIVE` and `DISCONTINUED` both pass; `ARCHIVED` does not. An adjustment
   * against archived merchandise would put units on a shelf the archive asserts
   * is empty, behind a status that has removed the item from every operational
   * screen. The remedy is explicit: restore it to `DISCONTINUED`, correct the
   * ledger, archive it again. This workflow will never change a lifecycle to
   * get its own write through.
   */
  function assertMayCorrect(variantId: string) {
    return async (tx: DatabaseClient): Promise<void> => {
      const variant = await deps.catalog.findVariantForCorrection(tx, variantId);
      if (!variant) throw notFound('Product variant');
      if (!variant.permitted) {
        throw conflict(
          `This product variant is ${variant.lifecycleStatus} and its stock record cannot be ` +
            'adjusted. Restore it to DISCONTINUED first if the correction is genuinely needed.',
        );
      }
    };
  }

  async function assertLocationIsStockable(locationId: string): Promise<void> {
    const location = await findLocationForStock(deps.pool, locationId);
    if (!location) throw notFound('Inventory location');
    if (!location.isActive) {
      throw conflict(
        'This inventory location is no longer active and its stock record cannot be adjusted',
      );
    }
  }

  return { adjustStock };
}

/**
 * Which movement type a signed correction is, and the whole of that decision.
 *
 * Zero never reaches here: the request schema refuses it, and the ledger's own
 * `CHECK (quantity_delta <> 0)` is the final word — a movement that changes
 * nothing is not a movement.
 */
function adjustmentTypeFor(quantityDelta: number): PostableMovementType {
  return quantityDelta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
}

/**
 * The persisted movement, reduced to what a caller is told.
 *
 * The same three fields whether the movement was just posted or was posted days
 * ago and is being retried, because a retry that answered differently would not
 * be a retry. The derived movement type is not echoed: the caller stated the
 * sign, and a screen that needed the server to confirm its own arithmetic would
 * be a screen that did not trust its own form.
 */
function toResult(movement: PostedMovement): AdjustStockResponse {
  return {
    operationId: movement.operationId,
    movementId: movement.id,
    quantityAfter: movement.quantityAfter,
  };
}
