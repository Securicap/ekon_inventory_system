import { z } from 'zod';
import {
  idSchema,
  movementResultSchema,
  noteSchema,
  occurredAtSchema,
  operationIdSchema,
  type MovementResult,
} from './movements.js';

/**
 * Reversal contracts — undoing one wrong movement, without editing history.
 *
 * A reversal is a **compensating movement**: a new `REVERSAL` row whose delta
 * is the exact negation of the movement it names, linked to it by
 * `reverses_movement_id`. The original row is not touched, because no row in
 * `inventory_movements` is ever touched (INV-1, and the database refuses it).
 *
 * ```text
 * wrong movement
 *     ↓
 * REVERSAL of it
 *     ↓
 * optional fresh correct movement
 * ```
 *
 * **The original movement is the authority.** The variant, the location, the
 * quantity, and the direction are all read from it inside the posting
 * transaction; none of them is a request field, and none may be. A client that
 * could state the quantity could "reverse" a receipt of 10 by 3 and leave the
 * ledger claiming a correction it never made.
 *
 * **A reversal is not an adjustment typed by hand.** An opposite
 * `ADJUSTMENT_OUT` would move the same stock and record none of the
 * relationship: nothing would say which movement was wrong, nothing would stop
 * it being "reversed" twice, and the two rows would read as an unexplained
 * correction rather than as a mistake and its remedy.
 *
 * **A reversal works against the current balance, not against history.**
 * Reversing a receipt of 10 that has since had 3 issued against it would leave
 * −3 on the shelf, and stock never goes below zero for any role by any path
 * (INV-8). That reversal is refused with `INSUFFICIENT_STOCK`; the later
 * movements are corrected first. The existence of a historical receipt is not
 * permission to violate the stock floor, and nothing is clamped.
 */

/**
 * `POST /api/inventory/reverse`.
 *
 * `.strict()`, and here the omissions are the contract. Beyond the usual
 * server-owned fields, four are refused specifically because they are
 * *derivable from the original movement* and a second statement of them could
 * only ever disagree:
 *
 * - `variantId`, `locationId` — the original names its own shelf, and a
 *   reversal that landed on a different one would move stock that was never
 *   wrong.
 * - `quantityDelta` — always the exact negation of the original's.
 * - `movementType`, `reversesMovementId` — the workflow posts a `REVERSAL` of
 *   the movement it was given; there is nothing here for a caller to choose.
 *
 * What the caller does own:
 *
 * - `operationId` — generated when the form opens and reused on every retry.
 * - `movementId` — the movement that was wrong. Permanent ledger evidence, and
 *   the one thing only the person looking at the history knows.
 * - `note` — optional. Why it was wrong, in their words.
 * - `occurredAt` — the business time of the correction. It is the correction's
 *   own time, not the original movement's: the mistake happened when it
 *   happened, and this is when somebody put it right.
 *
 * There is deliberately no `reason`. A reversal carries its reason in the
 * movement it reverses — that is what makes it a reversal rather than a fresh
 * movement in the opposite direction — and the ledger's own CHECK requires a
 * reason code for issues and adjustments only (INV-11).
 */
export const reverseMovementRequestSchema = z
  .object({
    operationId: operationIdSchema,
    /** The movement being corrected. Its row is read, never written. */
    movementId: idSchema,
    note: noteSchema.optional(),
    occurredAt: occurredAtSchema,
  })
  .strict();

export type ReverseMovementRequest = z.infer<typeof reverseMovementRequestSchema>;

/**
 * The result of a reversal: which command this answers, the movement it
 * produced, and what the shelf holds now.
 *
 * The shared `movementResultSchema`, unchanged and deliberately not widened.
 * The original movement is complex — it has a type, a reason, an actor, a
 * chain position, and now a reversal pointing at it — but none of that is the
 * answer to "did my correction post?". The command endpoint reports success;
 * `GET /api/inventory/movements` is where the evidence is read, and it shows
 * both rows and the link between them.
 *
 * `movementId` is the **reversal's** id, not the original's. A retry of the
 * same command returns this same body, with that same id.
 */
export const reverseMovementResponseSchema = movementResultSchema;

export type ReverseMovementResponse = MovementResult;
