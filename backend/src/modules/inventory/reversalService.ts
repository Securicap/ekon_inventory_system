import type { ReverseMovementRequest, ReverseMovementResponse } from '@ekon/shared';
import type { DatabaseClient } from '../../platform/db/pool.js';
import { conflict, notFound } from '../../platform/http/errors.js';
import type { CatalogService } from '../catalog/index.js';
import { REVERSAL_OPERATION_TYPE, reversalRequestHash } from './domain/reversalRequestHash.js';
import type { PostedMovement } from './infrastructure/ledgerRepository.js';
import type { LedgerService, OperationClaim } from './ledgerService.js';

/**
 * Reversal: undoing one wrong movement by appending its compensation.
 *
 * ```text
 * wrong movement
 *     ↓
 * REVERSAL of it
 *     ↓
 * optional fresh correct movement
 * ```
 *
 * **Nothing is edited and nothing is deleted.** A correction is new history
 * (INV-1, INV-2): the original row keeps its id, its type, its quantities, its
 * reason, its actor, and its place in the chain, and a new `REVERSAL` beside it
 * names it. Anyone reading the ledger afterwards sees both the mistake and the
 * remedy, which is the entire difference between a corrected record and an
 * altered one.
 *
 * This is the **thinnest** of the four workflows, because there is almost
 * nothing for it to decide. It does not choose the variant, the location, the
 * quantity, the direction, or the movement type — the original movement is the
 * authority on all of them, and the posting engine reads them off the row
 * inside the transaction. What this file owns is:
 *
 *  1. that the merchandise may still have its history corrected;
 *  2. what the canonical business command *was*, so a retry can be recognized;
 *  3. what the caller is told afterwards.
 *
 * The location is deliberately **not** checked. Every other workflow refuses a
 * closed location because it is being asked to move stock onto or off a shelf
 * that is out of use; a reversal is being asked to correct a movement that
 * already happened there. Refusing would make closing a location silently
 * freeze its history as uncorrectable, and a mistake would stay in the ledger
 * because of an unrelated operational decision.
 */

/**
 * One reversal command: which movement was wrong, and who says so.
 *
 * The actor is a separate field rather than a property of the request, because
 * it did not come from the request. It comes from the session the enforcement
 * hook resolved, and keeping the two apart in the type is what makes a body
 * that tries to supply a user id obviously wrong rather than merely rejected
 * somewhere else.
 */
export interface ReverseMovementCommand {
  /** The parsed request body — exactly what a caller is allowed to state. */
  request: ReverseMovementRequest;
  /** `request.actor.id`, from the session cookie. Never a value off the wire. */
  actorId: string;
}

export interface ReversalServiceDeps {
  /** The one trusted path into the ledger. Reversal never writes directly. */
  ledger: LedgerService;
  /**
   * The catalog's application service, narrowed to the one question this
   * workflow has: may this merchandise's record be corrected?
   *
   * The **correction** question and not the issue one, deliberately. Reversing
   * a receipt takes stock off a shelf and reversing an issue puts it back, so
   * reusing either the receiving or the removal rule would refuse half of the
   * legitimate corrections for reasons that have nothing to do with ledger
   * truth. Discontinued merchandise can always have its history corrected;
   * archived merchandise cannot, because a correction would leave stock behind
   * a status that asserts there is none.
   */
  catalog: Pick<CatalogService, 'findVariantForCorrection'>;
}

export interface ReversalService {
  reverseMovement(command: ReverseMovementCommand): Promise<ReverseMovementResponse>;
}

export function createReversalService(deps: ReversalServiceDeps): ReversalService {
  async function reverseMovement({
    request,
    actorId,
  }: ReverseMovementCommand): Promise<ReverseMovementResponse> {
    // The wire carries a string; everything downstream works in instants. One
    // conversion, here, so the hash and the ledger agree on what time it was.
    const occurredAt = new Date(request.occurredAt);
    const note = request.note ?? null;

    const claim: OperationClaim = {
      operationId: request.operationId,
      operationType: REVERSAL_OPERATION_TYPE,
      requestHash: reversalRequestHash({
        movementId: request.movementId,
        note,
        occurredAt,
        actorId,
      }),
    };

    /**
     * Settled first, present tense second.
     *
     * A retry of a reversal that already posted is a question about the past,
     * and the answer must not depend on what happened to the merchandise
     * afterwards — including on its having been archived *because* this very
     * reversal brought its stock back to zero. Without this lookup, a client
     * that never received the first response would retry into a conflict about
     * merchandise the correction itself made archivable.
     *
     * There is a second replay in the engine's own transaction, and it is the
     * authoritative one. This is a shortcut to an answer already committed.
     */
    const alreadyPosted = await deps.ledger.findCompletedMovement(claim);
    if (alreadyPosted) return toResult(alreadyPosted);

    const movement = await deps.ledger.postReversal({
      ...claim,
      // The only thing this workflow tells the engine about what to move: which
      // movement was wrong. Everything else is read from that row.
      movementId: request.movementId,
      note,
      userId: actorId,
      occurredAt,
      precondition: assertMayCorrect,
    });

    return toResult(movement);
  }

  /**
   * The lifecycle rule, checked inside the posting transaction once the engine
   * has read the original movement and therefore knows which variant this is
   * about.
   *
   * That ordering is why the precondition takes the variant id rather than
   * closing over one: a reversal request does not name a variant, and inventing
   * a lookup here to find it before the engine does would be a second read of
   * the same row with a second chance to disagree with it.
   */
  async function assertMayCorrect(tx: DatabaseClient, variantId: string): Promise<void> {
    const variant = await deps.catalog.findVariantForCorrection(tx, variantId);
    // Unreachable in practice — the movement's foreign key guarantees the
    // variant exists (INV-12 forbids deleting one with history) — but a `404`
    // is the honest answer if it ever is not, rather than a crash.
    if (!variant) throw notFound('Product variant');
    if (!variant.permitted) {
      throw conflict(
        `This product variant is ${variant.lifecycleStatus} and its movements cannot be ` +
          'reversed. Restore it to DISCONTINUED first, correct the ledger, then archive it again.',
      );
    }
  }

  return { reverseMovement };
}

/**
 * The persisted reversal, reduced to what a caller is told.
 *
 * The same three fields every other command answers with, and deliberately not
 * widened because the original movement is complex. `movementId` is the
 * **reversal's** id; `quantityAfter` is what the shelf holds now. What the
 * original was, what it did, and the link between the two rows is evidence, and
 * evidence is read from `GET /api/inventory/movements` rather than reported by
 * the command that produced it.
 */
function toResult(movement: PostedMovement): ReverseMovementResponse {
  return {
    operationId: movement.operationId,
    movementId: movement.id,
    quantityAfter: movement.quantityAfter,
  };
}
