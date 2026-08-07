import { z } from 'zod';
import {
  MAX_MOVEMENT_QUANTITY,
  idSchema,
  movementResultSchema,
  occurredAtSchema,
  operationIdSchema,
  type MovementResult,
} from './movements.js';

/**
 * Stock removal contracts — recording that stock left through ordinary
 * operations.
 *
 * This is the counterpart to receiving, and the smallest complete statement the
 * business can make about stock leaving: *this many of this variant left this
 * location, for this reason, at this time*. It posts an `ISSUE` movement.
 *
 * **It is not an adjustment.** An `ISSUE` says stock genuinely left the shelf —
 * a customer bought it, a bottle broke, staff used it. An `ADJUSTMENT_OUT` says
 * the recorded balance was wrong and somebody corrected it downward; the stock
 * had already gone, or had never been there. Two facts that look identical in a
 * balance and mean opposite things in a history: the first is trade, the second
 * is a recording error. The distinction is permanent once it is written, which
 * is why they are different movement types rather than one type with a reason
 * that could be chosen wrongly.
 *
 * **It is not a sale.** `SOLD` is a reason a unit left inventory and nothing
 * more. There is no customer here, no price, no receipt, no payment, no tax,
 * and no line item — the inventory ledger records only *why* stock left. A
 * point-of-sale module, if one is ever built, would call this workflow (or an
 * orchestration above it) rather than teach the ledger about money.
 *
 * One request removes one variant from one location. Nothing here is a list: a
 * screen with several lines sends several independent operations, each with its
 * own operation id, so one line failing cannot half-apply the others.
 */

/**
 * Why stock left. A closed set, deliberately short.
 *
 * These are the categories a shop can answer honestly at the counter, in the
 * moment, without stopping to think — which is the only kind of category that
 * stays accurate. A longer list gets used as a guess, and a guess recorded in a
 * permanent ledger is worse than a coarse truth.
 *
 * The stored value is the code, not a translation. `SOLD` means the same thing
 * in the database whatever language the person who typed it was reading, and it
 * stays readable in five years when the interface has been rewritten twice.
 * Free text is deliberately not accepted: a reason somebody can type is a
 * reason nobody can count.
 *
 * - `SOLD` — a customer bought it. The ordinary case, and the reason this
 *   workflow exists.
 * - `DAMAGED` — broken, spoiled, or otherwise no longer sellable, and
 *   discarded. Physically gone from the shelf either way.
 * - `INTERNAL_USE` — the business consumed it itself.
 * - `OTHER` — a legitimate removal that is none of the above. Present because
 *   the alternative is somebody choosing a wrong reason from a list that has no
 *   right one, and a wrong reason is worse than an unspecific one.
 */
export const REMOVAL_REASONS = ['SOLD', 'DAMAGED', 'INTERNAL_USE', 'OTHER'] as const;

export const removalReasonSchema = z.enum(REMOVAL_REASONS);
export type RemovalReason = z.infer<typeof removalReasonSchema>;

/**
 * `POST /api/inventory/remove`.
 *
 * `.strict()`, and that is most of the contract. Everything the server owns —
 * the user id, the movement id, the movement type, the quantity delta and its
 * sign, the recorded time, the before and after quantities, the predecessor
 * movement, the request hash — is not merely absent from this schema but
 * *refused* by it. A body carrying `userId` is rejected rather than ignored,
 * because a client that can send one and get a `201` will keep sending it and
 * eventually somebody will wire it up.
 *
 * `reasonCode` is refused for a subtler reason: it is the ledger's column name.
 * The public field is `reason`, drawn from a closed business vocabulary, and the
 * workflow maps it. A client that could set `reason_code` directly could write
 * a reason no screen offers and no report counts.
 *
 * What the caller does own is the business event and the identity of the
 * command:
 *
 * - `operationId` — generated when the form opens and reused on every retry,
 *   including after a page reload. It is how a retry names the command it is
 *   repeating; a fresh id per attempt defeats duplicate protection entirely.
 * - `variantId`, `locationId` — what left, and the shelf it left from. Stock
 *   comes off the location that was asked for and no other; there is no
 *   fallback to wherever the units happen to be.
 * - `quantity` — how much left, in whole base units. **Positive**, always.
 * - `reason` — why it left.
 * - `occurredAt` — when it physically left.
 */
export const removeStockRequestSchema = z
  .object({
    operationId: operationIdSchema,
    variantId: idSchema,
    locationId: idSchema,
    /**
     * Whole units, strictly positive — the amount that left, stated the way a
     * person would state it.
     *
     * The request never carries a sign. A caller that wrote `-5` would be
     * describing the ledger's representation rather than the business event,
     * and a workflow that accepted both a negative quantity and negated it
     * would have two spellings of one command — which is one spelling too many
     * for a hash that has to recognize a retry. Direction belongs to the
     * workflow: `remove` removes, and the server derives `quantityDelta`.
     *
     * Zero is not a removal, a fraction is a data-integrity defect this ledger
     * cannot represent, and the ceiling is the database's own integer bound so
     * an unstorable quantity is a `400` rather than a `500`.
     */
    quantity: z
      .number()
      .int('quantity must be a whole number of units')
      .positive('quantity must be greater than zero')
      .max(MAX_MOVEMENT_QUANTITY),
    reason: removalReasonSchema,
    occurredAt: occurredAtSchema,
  })
  .strict();

export type RemoveStockRequest = z.infer<typeof removeStockRequestSchema>;

/**
 * The result of a removal: which command this answers, the movement it
 * produced, and what the shelf holds now.
 *
 * The shared `movementResultSchema` — the same three fields receiving answers
 * with, because the caller of either already knows what it asked to move and
 * the one thing only the server can say is what is left. `quantityAfter` is
 * routinely `0`, and zero is a successful removal: the shelf is empty, not the
 * request refused.
 *
 * The reason is deliberately not echoed. The client sent it, and a screen that
 * needed the server to confirm its own input would be a screen that did not
 * trust its own form.
 */
export const removeStockResponseSchema = movementResultSchema;

export type RemoveStockResponse = MovementResult;
