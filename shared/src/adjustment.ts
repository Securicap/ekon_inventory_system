import { z } from 'zod';
import {
  MAX_MOVEMENT_QUANTITY,
  idSchema,
  movementResultSchema,
  noteSchema,
  occurredAtSchema,
  operationIdSchema,
  type MovementResult,
} from './movements.js';

/**
 * Adjustment contracts — correcting a recorded quantity that was wrong.
 *
 * An adjustment is the smallest complete statement the business can make about
 * a **recording error**: *the ledger says this shelf holds n, it does not, and
 * here is why the record was wrong*. It posts an `ADJUSTMENT_IN` or an
 * `ADJUSTMENT_OUT`, and the server decides which from the sign.
 *
 * **It is not a removal, and it is not a receipt.** An `ISSUE` says stock
 * genuinely left through ordinary operations and a `RECEIPT` says stock
 * genuinely arrived; an adjustment says nothing physical happened at all — the
 * number was wrong. The two look identical in a balance and mean opposite
 * things in a history: one is trade, the other is a correction to the record of
 * it. That is why they are different movement types under different
 * capabilities, and why `inventory.adjust` is deliberately not granted to
 * everybody who holds `inventory.remove`: recording that stock left is what
 * somebody does at the counter all day, and making a shortfall disappear is
 * authority over the records themselves.
 *
 * **It is not a reversal.** A reversal compensates one identified wrong
 * movement and derives its own quantity from it (`POST /api/inventory/reverse`).
 * An adjustment is what is left when there is no single movement to point at:
 * a receipt that was never recorded, a quantity typed wrongly weeks ago and
 * discovered now, stock found on a shelf nobody had booked in. Reaching for an
 * adjustment when the wrong movement is known and reversible would throw away
 * the link between the mistake and its correction.
 *
 * **It is not a physical count.** A count observes reality, and reconciliation
 * changes the system through a `COUNT_RECONCILIATION` movement that records
 * what was expected and what was seen (INV-9). Using an adjustment to make the
 * system agree with a count would destroy the variance, which is the only
 * signal the shop had. Counts are their own workflow.
 *
 * One request adjusts one variant at one location. Nothing here is a list.
 */

/**
 * Why a recorded quantity needs correcting. A closed set, deliberately short.
 *
 * These describe **the record**, not the stock. That is the whole difference
 * from `REMOVAL_REASONS`, which describe why stock physically left: `SOLD`,
 * `DAMAGED`, and `INTERNAL_USE` are things that happened to merchandise, and
 * none of them is ever an adjustment reason. Stock that was sold left the shelf
 * and is removed; a sale nobody recorded is a **missed movement**, and the
 * distinction is exactly what tells a shop the difference between trade it
 * knows about and bookkeeping it is catching up on.
 *
 * The stored value is the code, not a translation, and it stays readable in
 * five years when the interface has been rewritten twice.
 *
 * - `DATA_ENTRY_ERROR` — the quantity that was recorded is not the quantity
 *   that was meant. A delivery of 12 entered as 21, or the same receipt entered
 *   twice by two people. The stock is what it always was; the record is wrong.
 * - `MISSED_MOVEMENT` — stock genuinely moved and was never recorded at all. A
 *   delivery booked in on paper and not in Ekon, a sale rung up while the
 *   system was unreachable, merchandise found on a shelf that nobody entered.
 *   The record is behind reality rather than wrong about it.
 * - `OTHER` — a legitimate correction that is neither of the above, and it
 *   **requires a note**. Present because the alternative is somebody choosing a
 *   wrong reason from a list that has no right one, and a wrong reason recorded
 *   in a permanent ledger is worse than an unspecific one with a sentence
 *   beside it.
 *
 * Deliberately absent: anything that names a cause the system cannot
 * distinguish. `SHRINKAGE`, `THEFT`, `MISCOUNT`, and `SPOILAGE` are conclusions
 * about a variance, and a variance is what a physical count produces —
 * investigating it is the count workflow's business (see the count principle in
 * `docs/03-architecture/retail-domain-and-or1.md`). Offering them here would
 * invite somebody to adjust a balance to whatever they last counted and record
 * a guess about why, which is precisely the flattening that stops a shop
 * noticing it is being stolen from.
 */
export const ADJUSTMENT_REASONS = ['DATA_ENTRY_ERROR', 'MISSED_MOVEMENT', 'OTHER'] as const;

export const adjustmentReasonSchema = z.enum(ADJUSTMENT_REASONS);
export type AdjustmentReason = z.infer<typeof adjustmentReasonSchema>;

/**
 * `POST /api/inventory/adjust`.
 *
 * `.strict()`, and that is most of the contract. Everything the server owns —
 * the user id, the movement id, the movement **type**, the recorded time, the
 * before and after quantities, the predecessor movement, the request hash — is
 * not merely absent from this schema but *refused* by it. A body carrying
 * `userId` or `movementType` is rejected rather than ignored.
 *
 * `movementType` is the one worth naming twice. The caller states a signed
 * `quantityDelta` and the server derives `ADJUSTMENT_IN` or `ADJUSTMENT_OUT`
 * from its sign, so the two can never disagree. A client that could send both
 * could write an `ADJUSTMENT_IN` that removed stock, and the ledger would be
 * permanently wrong in a way no reversal can un-say.
 *
 * What the caller does own is the business event and the identity of the
 * command:
 *
 * - `operationId` — generated when the form opens and reused on every retry,
 *   including after a page reload.
 * - `variantId`, `locationId` — whose record is wrong, and on which shelf.
 * - `quantityDelta` — how wrong, and in which direction. **Signed**, unlike
 *   every other workflow's quantity.
 * - `reason` — why the record needs correcting.
 * - `note` — optional, and required when the reason is `OTHER`.
 * - `occurredAt` — the business time of the correction.
 */
export const adjustStockRequestSchema = z
  .object({
    operationId: operationIdSchema,
    variantId: idSchema,
    locationId: idSchema,
    /**
     * The signed correction, in whole base units.
     *
     * **The one workflow whose quantity carries a sign, and it has to.**
     * Receiving always adds and removal always subtracts, so each states a
     * positive number and derives its own direction; an adjustment is a single
     * command that can go either way, and the direction is the caller's
     * statement about which way the record was wrong. Splitting it into two
     * endpoints would put the same decision in a URL instead of a field, and
     * splitting it into a positive quantity plus a direction word would give
     * one command two spellings — one too many for a hash that has to recognize
     * a retry.
     *
     * Zero is not a correction: a movement that changes nothing is not a
     * movement, and the ledger refuses one by CHECK (INV-3). A fraction is a
     * data-integrity defect this ledger cannot represent. The bound at both ends
     * is the database's own integer ceiling, so an unstorable quantity is a
     * `400` rather than a `500`.
     *
     * Whether the shelf can absorb a negative correction is not decided here.
     * Stock never goes below zero (INV-8), and an adjustment that would take it
     * there is refused by the posting engine with `INSUFFICIENT_STOCK` — not
     * clamped, and not partially applied.
     */
    quantityDelta: z
      .number()
      .int('quantityDelta must be a whole number of units')
      .refine((n) => n !== 0, 'quantityDelta must not be zero')
      .refine(
        (n) => Math.abs(n) <= MAX_MOVEMENT_QUANTITY,
        'quantityDelta is larger than the ledger can store',
      ),
    reason: adjustmentReasonSchema,
    /**
     * What happened, in the words of whoever corrected it.
     *
     * Optional in general and **required for `OTHER`**, which is the only
     * reason that says nothing on its own. An `OTHER` with no note records that
     * somebody changed a balance and declined to say why, which is the one
     * outcome this workflow exists to prevent.
     */
    note: noteSchema.optional(),
    occurredAt: occurredAtSchema,
  })
  .strict()
  .refine((request) => request.reason !== 'OTHER' || request.note !== undefined, {
    message: 'A note is required when the reason is OTHER',
    path: ['note'],
  });

export type AdjustStockRequest = z.infer<typeof adjustStockRequestSchema>;

/**
 * The result of an adjustment: which command this answers, the movement it
 * produced, and what the shelf holds now.
 *
 * The shared `movementResultSchema` — the same three fields receiving and
 * removal answer with. The movement type the server derived is deliberately not
 * echoed: the caller stated the sign, and a screen that needed the server to
 * confirm its own arithmetic would be a screen that did not trust its own form.
 * What it could not know, and what it is told, is `quantityAfter`.
 *
 * A retry of the same command returns this same body, with the same
 * `movementId`: replaying is answered, not re-posted.
 */
export const adjustStockResponseSchema = movementResultSchema;

export type AdjustStockResponse = MovementResult;
