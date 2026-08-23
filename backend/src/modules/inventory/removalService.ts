import type { RemoveStockRequest, RemoveStockResponse } from '@ekon/shared';
import type { PostedMovement } from './infrastructure/ledgerRepository.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { conflict, notFound } from '../../platform/http/errors.js';
import type { CatalogService } from '../catalog/index.js';
import { REMOVAL_OPERATION_TYPE, removalRequestHash } from './domain/removalRequestHash.js';
import { findLocationForStock } from './infrastructure/locationRepository.js';
import type { LedgerService, OperationClaim } from './ledgerService.js';

/**
 * Stock removal: the first workflow that takes stock *out* of the ledger.
 *
 * Structurally receiving's mirror image, and deliberately its own file rather
 * than a shared "movement workflow" with a direction flag. The two differ in
 * every decision that matters — which capability, which movement type, which
 * sign, whether a reason is required, what a shortfall means — and a
 * parameterized workflow would put all of those behind one branch, where the
 * next workflow's exception makes the branch wrong for one of the existing two.
 * They share the posting engine, the canonical hasher, and the location lookup,
 * which is where the shared behaviour actually is.
 *
 * Like receiving, it is a thin caller. Everything about *how* a movement is
 * written — the movement id, the recorded time, the quantity before and after,
 * the chain pointer, the row lock, the operation claim, the replay, and the
 * stock floor — belongs to the posting engine and is not repeated, wrapped, or
 * second-guessed here. What this file owns is the five things the engine cannot
 * know:
 *
 *  1. that the variant and the location are real, and that the merchandise may
 *     still have stock **taken off** it;
 *  2. what the canonical business command *was*, so a retry can be recognized;
 *  3. that removal means an `ISSUE` of a **negative** quantity, whatever the
 *     request wanted;
 *  4. that the caller's business reason becomes the ledger's `reason_code`;
 *  5. what the caller is told afterwards.
 *
 * **This is not an adjustment.** An `ISSUE` says stock genuinely left the
 * shelf. An `ADJUSTMENT_OUT` says the recorded balance was wrong and somebody
 * corrected it downward. They look identical in a balance and mean opposite
 * things in a history — trade, or a recording error — and the ledger is
 * append-only, so a movement written under the wrong one is wrong forever. The
 * adjustment workflow is its own PR and its own capability.
 *
 * **This is not a sale.** `SOLD` is a reason a unit left inventory and nothing
 * more. There is no customer, no price, no receipt, no payment, and no line
 * item anywhere in this file.
 */

/**
 * One removal command: what the caller stated, and who they turned out to be.
 *
 * The actor is a separate field rather than a property of the request, because
 * it did not come from the request. It comes from the session the enforcement
 * hook resolved, and keeping the two apart in the type is what makes a body
 * that tries to supply a user id obviously wrong rather than merely rejected
 * somewhere else.
 */
export interface RemoveStockCommand {
  /** The parsed request body — exactly what a caller is allowed to state. */
  request: RemoveStockRequest;
  /** `request.actor.id`, from the session cookie. Never a value off the wire. */
  actorId: string;
}

export interface RemovalServiceDeps {
  pool: DatabasePool;
  /** The one trusted path into the ledger. Removal never writes directly. */
  ledger: LedgerService;
  /**
   * The catalog's application service. Variants belong to the catalog module,
   * so this module asks it rather than querying `product_variants` — narrowed
   * to the one question removal has, so the dependency is visible in the type.
   *
   * **A different question from receiving's, and that is the point.** Removal
   * asks whether stock may be *issued*, which is true of discontinued
   * merchandise and false of archived; receiving asks whether stock may be
   * *received*, which is false of both. Each workflow is given only its own
   * question, so neither can answer with the other's rule and quietly refuse a
   * sale of something the shop simply stopped reordering.
   */
  catalog: Pick<CatalogService, 'findVariantForIssue'>;
}

export interface RemovalService {
  removeStock(command: RemoveStockCommand): Promise<RemoveStockResponse>;
}

export function createRemovalService(deps: RemovalServiceDeps): RemovalService {
  async function removeStock({
    request,
    actorId,
  }: RemoveStockCommand): Promise<RemoveStockResponse> {
    // The wire carries a string; everything downstream works in instants. One
    // conversion, here, so the hash and the ledger agree on what time it was —
    // `10:00-05:00` and `15:00Z` are the same stock-out and must hash alike.
    const occurredAt = new Date(request.occurredAt);

    const claim: OperationClaim = {
      operationId: request.operationId,
      operationType: REMOVAL_OPERATION_TYPE,
      // The server's digest of the server's canonical form. No client submits a
      // request hash: one that could would decide for itself whether its own
      // retry counted as the same command.
      requestHash: removalRequestHash({
        variantId: request.variantId,
        locationId: request.locationId,
        // The public positive quantity, not the delta below. The digest is of
        // the request that was made, and there is exactly one way to state it.
        quantity: request.quantity,
        reason: request.reason,
        occurredAt,
        actorId,
      }),
    };

    /**
     * Settled first, present tense second — the same rule receiving follows,
     * and for a reason removal makes even sharper.
     *
     * A retry of a stock-out that already posted is a question about the past,
     * and the answer cannot depend on what happened to the variant afterwards.
     * An item sold in the morning and retired from the catalog that afternoon
     * would otherwise make the morning's sale unanswerable, and a client that
     * never got the first response would retry forever into a `409` — for stock
     * that has already left the building.
     *
     * A mismatched hash raises `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` from
     * inside that lookup — which is the right answer and the right order. One
     * operation id used for two different commands is a conflict about the id,
     * not a fact about the variant, and reporting it as "this item is inactive"
     * would send somebody to fix the wrong thing.
     *
     * This decides nothing about whether the command is *new*. `null` means
     * only that the engine has no committed answer yet; the transactional claim
     * inside `postMovement` is still the sole authority on who owns the id.
     */
    const alreadyPosted = await deps.ledger.findCompletedMovement(claim);
    if (alreadyPosted) return toResult(alreadyPosted);

    // Business validation, not foreign-key roulette: an unknown location would
    // eventually fail at the database, but as a constraint violation inside a
    // transaction — a 500 that says nothing about which id was wrong, to a
    // person at a counter who can only fix it if they are told.
    //
    // The **variant** is checked inside the posting transaction instead, as a
    // precondition, so a lifecycle change cannot commit between the check and
    // the movement. See `assertMayIssue`.
    await assertLocationIsStockable(request.locationId);

    const movement = await deps.ledger.postMovement({
      ...claim,
      variantId: request.variantId,
      locationId: request.locationId,
      // Fixed by the workflow, not chosen by the request. `ISSUE` says stock
      // left through ordinary operations; a request that could pick the type
      // could write an adjustment through an endpoint whose capability says
      // `remove`, and call a shortfall a correction.
      movementType: 'ISSUE',
      /**
       * The one place direction is decided.
       *
       * The caller states how much left, positively, because that is how a
       * person says it. Negating it here — once, in the workflow that owns the
       * meaning — is what keeps a negative number out of the contract, out of
       * the hash, and out of every screen. A request that could send its own
       * sign could add stock through the removal endpoint.
       *
       * Nothing checks the balance first. Whether the shelf holds enough is the
       * posting engine's question, answered under the row lock it already
       * takes; asking here would be a read that is stale by the time it is
       * used, and two callers could both be told there was enough.
       */
      quantityDelta: -request.quantity,
      // The business reason becomes the ledger's reason code, unchanged and
      // untranslated. `SOLD` means the same thing in the database whatever
      // language the person reading the screen was using.
      reasonCode: request.reason,
      // This workflow has no note field, and none is invented to fill a
      // parameter. Free text a person types is not a reason anybody can count.
      note: null,
      userId: actorId,
      occurredAt,
      precondition: assertMayIssue(request.variantId),
    });

    // Whichever way the engine answered — a fresh post, or a replay resolved by
    // its own transactional claim when a concurrent attempt got there first —
    // the result is read off the persisted row rather than the values this
    // service sent in.
    return toResult(movement);
  }

  /**
   * The lifecycle rule, as a check the posting engine runs inside its own
   * transaction — where it takes a lock on the merchandise, so a concurrent
   * lifecycle change and this stock-out cannot cross unnoticed.
   *
   * **`ACTIVE` and `DISCONTINUED` both pass**, and that is the difference that
   * made the old single flag untenable. Discontinuing something is a decision
   * about replenishment, not about the units already on the shelf: they are
   * still sold, and a system that refused to record it would not stop the sale
   * — it would only stop knowing about it. `ARCHIVED` is refused, deliberately
   * and not merely because archived merchandise has no stock to issue: the
   * lifecycle is enforced on its own terms rather than left to be implied by a
   * quantity.
   *
   * Refused is a conflict rather than a 404: the variant plainly exists, and
   * telling somebody holding the last two bottles that it does not would send
   * them looking for a typo instead of for whoever withdrew the item.
   */
  function assertMayIssue(variantId: string) {
    return async (tx: DatabaseClient): Promise<void> => {
      const variant = await deps.catalog.findVariantForIssue(tx, variantId);
      if (!variant) throw notFound('Product variant');
      if (!variant.permitted) {
        throw conflict(
          `This product variant is ${variant.lifecycleStatus} and stock cannot be removed from it`,
        );
      }
    };
  }

  async function assertLocationIsStockable(locationId: string): Promise<void> {
    const location = await findLocationForStock(deps.pool, locationId);
    if (!location) throw notFound('Inventory location');
    if (!location.isActive) {
      throw conflict(
        'This inventory location is no longer active and stock cannot be removed from it',
      );
    }
  }

  return { removeStock };
}

/**
 * The persisted movement, reduced to what a caller is told.
 *
 * The same three fields whether the movement was just posted or was posted days
 * ago and is being retried, because a retry that answered differently would not
 * be a retry. Everything else on the row — the chain pointer, the quantity
 * before, the negative delta, the reason code the caller already knows, the
 * recorded time — stays inside.
 */
function toResult(movement: PostedMovement): RemoveStockResponse {
  return {
    operationId: movement.operationId,
    movementId: movement.id,
    quantityAfter: movement.quantityAfter,
  };
}
