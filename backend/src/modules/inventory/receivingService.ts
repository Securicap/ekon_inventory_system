import type { ReceiveStockRequest, ReceiveStockResponse } from '@ekon/shared';
import type { PostedMovement } from './infrastructure/ledgerRepository.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { conflict, notFound } from '../../platform/http/errors.js';
import type { CatalogService } from '../catalog/index.js';
import { RECEIVING_OPERATION_TYPE, receivingRequestHash } from './domain/receivingRequestHash.js';
import { findLocationForStock } from './infrastructure/locationRepository.js';
import type { LedgerService, OperationClaim } from './ledgerService.js';

/**
 * Receiving: the first workflow that puts anything in the ledger.
 *
 * It is a thin caller by design. Everything about *how* a movement is written —
 * the movement id, the recorded time, the quantity before and after, the chain
 * pointer, the row lock, the operation claim, the replay — belongs to the
 * posting engine and is not repeated, wrapped, or second-guessed here. What
 * this file owns is the four things the engine cannot know:
 *
 *  1. that the variant and the location are real, and that the merchandise may
 *     still be **received into**;
 *  2. what the canonical business command *was*, so a retry can be recognized;
 *  3. that receiving means a `RECEIPT` of a positive quantity, whatever the
 *     request wanted;
 *  4. what the caller is told afterwards.
 *
 * There is no receipt record, no supplier, and no document. The movement is the
 * receiving record — a second table beside it would be a second history to keep
 * in step with the ledger, and the ledger is the one that must be believed.
 */

/**
 * One receiving command: what the caller stated, and who they turned out to be.
 *
 * The actor is a separate field rather than a property of the request, because
 * it did not come from the request. It comes from the session the enforcement
 * hook resolved, and keeping the two apart in the type is what makes a body
 * that tries to supply a user id obviously wrong rather than merely rejected
 * somewhere else.
 */
export interface ReceiveStockCommand {
  /** The parsed request body — exactly what a caller is allowed to state. */
  request: ReceiveStockRequest;
  /** `request.actor.id`, from the session cookie. Never a value off the wire. */
  actorId: string;
}

export interface ReceivingServiceDeps {
  pool: DatabasePool;
  /** The one trusted path into the ledger. Receiving never writes directly. */
  ledger: LedgerService;
  /**
   * The catalog's application service. Variants belong to the catalog module,
   * so this module asks it rather than querying `product_variants` — narrowed
   * to the one question receiving has, so the dependency is visible in the type.
   *
   * The narrowing is a safety property, not documentation. Receiving may ask
   * whether merchandise can be **received into** and has no access to the issue
   * rule, so it cannot accidentally accept a delivery against discontinued
   * merchandise by calling the wrong lookup — the type simply does not have it.
   */
  catalog: Pick<CatalogService, 'findVariantForReceiving'>;
}

export interface ReceivingService {
  receiveStock(command: ReceiveStockCommand): Promise<ReceiveStockResponse>;
}

export function createReceivingService(deps: ReceivingServiceDeps): ReceivingService {
  async function receiveStock({
    request,
    actorId,
  }: ReceiveStockCommand): Promise<ReceiveStockResponse> {
    // The wire carries a string; everything downstream works in instants. One
    // conversion, here, so the hash and the ledger agree on what time it was —
    // `10:00-05:00` and `15:00Z` are the same delivery and must hash alike.
    const occurredAt = new Date(request.occurredAt);

    const claim: OperationClaim = {
      operationId: request.operationId,
      operationType: RECEIVING_OPERATION_TYPE,
      // The server's digest of the server's canonical form. No client submits
      // a request hash: one that could would decide for itself whether its own
      // retry counted as the same command.
      requestHash: receivingRequestHash({
        variantId: request.variantId,
        locationId: request.locationId,
        quantity: request.quantity,
        occurredAt,
        actorId,
      }),
    };

    /**
     * Settled first, present tense second.
     *
     * A retry of a receipt that already posted is a question about the past,
     * and the answer cannot depend on what happened to the variant afterwards:
     * an item retired at the end of the day would otherwise make that
     * afternoon's delivery unanswerable, and a client that never got the first
     * response would retry forever into a `409`. So the engine is asked what
     * this operation already produced *before* anything is checked about today.
     *
     * A mismatched hash raises `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` from
     * inside that lookup — which is the right answer and the right order. One
     * operation id used for two different commands is a conflict about the id,
     * not a fact about the variant, and reporting it as "this item is inactive"
     * would send somebody to fix the wrong thing.
     *
     * This decides nothing about whether the command is *new*. `null` means
     * only that the engine has no committed answer yet; the transactional claim
     * below is still the sole authority on who owns the operation id.
     */
    const alreadyPosted = await deps.ledger.findCompletedMovement(claim);
    if (alreadyPosted) return toResult(alreadyPosted);

    // Business validation, not foreign-key roulette: an unknown location would
    // eventually fail at the database, but as a constraint violation inside a
    // transaction — a 500 that says nothing about which id was wrong, to a
    // person at a counter who can only fix it if they are told.
    //
    // The **variant** is deliberately not checked here. Its check goes into the
    // posting transaction as a precondition, because merchandise can be
    // archived between a check on the pool and the write that follows it, and
    // an archived SKU with a delivery booked into it is precisely the state
    // archive safety exists to make impossible. See `assertMayReceive`.
    await assertLocationIsStockable(request.locationId);

    const movement = await deps.ledger.postMovement({
      ...claim,
      variantId: request.variantId,
      locationId: request.locationId,
      // Fixed by the workflow, not chosen by the request. Receiving adds stock;
      // a request that could pick the type or the sign could remove it through
      // an endpoint whose capability says `receive`.
      movementType: 'RECEIPT',
      quantityDelta: request.quantity,
      // A receipt carries its reason in its type, and this workflow has no
      // field for a note. Neither is invented here to fill a parameter.
      reasonCode: null,
      note: null,
      userId: actorId,
      occurredAt,
      precondition: assertMayReceive(request.variantId),
    });

    // Whichever way the engine answered — a fresh post, or a replay resolved by
    // its own transactional claim when a concurrent attempt got there first —
    // the result is read off the persisted row rather than the values this
    // service sent in.
    return toResult(movement);
  }

  /**
   * The lifecycle rule, as a check the posting engine runs inside its own
   * transaction.
   *
   * The catalog answers it and locks the merchandise rows while it does, so a
   * lifecycle change and this delivery cannot cross unnoticed: one of them
   * waits for the other and is then refused. That is the whole of archive
   * safety on this side.
   *
   * **`ACTIVE` only.** `DISCONTINUED` merchandise is merchandise the business
   * decided to stop buying, and a delivery of it is either a mistake or a
   * decision somebody needs to make explicitly by making it active again;
   * `ARCHIVED` is out of operation altogether. The catalog decides which
   * statuses those are — this workflow does not interpret lifecycle, it asks a
   * question named after what it is about to do.
   *
   * Refused is a conflict rather than a 404: the variant plainly exists, and
   * telling somebody holding a delivery that it does not would send them
   * looking for a typo instead of for whoever withdrew the item.
   */
  function assertMayReceive(variantId: string) {
    return async (tx: DatabaseClient): Promise<void> => {
      const variant = await deps.catalog.findVariantForReceiving(tx, variantId);
      if (!variant) throw notFound('Product variant');
      if (!variant.permitted) {
        throw conflict(
          `This product variant is ${variant.lifecycleStatus} and cannot receive stock`,
        );
      }
    };
  }

  async function assertLocationIsStockable(locationId: string): Promise<void> {
    const location = await findLocationForStock(deps.pool, locationId);
    if (!location) throw notFound('Inventory location');
    if (!location.isActive) {
      throw conflict('This inventory location is no longer active and cannot receive stock');
    }
  }

  return { receiveStock };
}

/**
 * The persisted movement, reduced to what a caller is told.
 *
 * The same three fields whether the movement was just posted or was posted days
 * ago and is being retried, because a retry that answered differently would not
 * be a retry. Everything else on the row — the chain pointer, the quantity
 * before, the recorded time, the operation's own state — stays inside.
 */
function toResult(movement: PostedMovement): ReceiveStockResponse {
  return {
    operationId: movement.operationId,
    movementId: movement.id,
    quantityAfter: movement.quantityAfter,
  };
}
