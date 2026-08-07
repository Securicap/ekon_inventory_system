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
 * Receiving contracts — booking in stock that arrived.
 *
 * Receiving is the smallest complete statement the business can make about
 * arriving stock: *this many of this variant reached this location at this
 * time*. There is no supplier, no purchase order, no document, and no receipt
 * record of its own. The inventory movement **is** the business record; a
 * receiving table beside it would be a second history to keep in step with the
 * ledger, and the ledger is the one that must be believed.
 *
 * One request receives one variant at one location. Nothing here is a list:
 * a screen with several lines sends several independent operations, each with
 * its own operation id, so one line failing cannot half-apply the others.
 */

/**
 * `POST /api/inventory/receive`.
 *
 * `.strict()`, and that is most of the contract. Everything the server owns —
 * the user id, the movement id, the movement type, the quantity delta and its
 * sign, the recorded time, the before and after quantities, the predecessor
 * movement, the request hash — is not merely absent from this schema but
 * *refused* by it. A body carrying `userId` is rejected rather than ignored,
 * because a client that can send one and get a `201` will keep sending it and
 * eventually somebody will wire it up.
 *
 * What the caller does own is the business event and the identity of the
 * command:
 *
 * - `operationId` — generated when the form opens and reused on every retry,
 *   including after a page reload. It is how a retry names the command it is
 *   repeating; a fresh id per attempt defeats duplicate protection entirely.
 * - `variantId`, `locationId` — what arrived, and where. Stable ids: no SKU, no
 *   product id, no names. The variant already establishes its product.
 * - `quantity` — how much arrived, in whole base units. Always positive; a
 *   correction is not a receipt.
 * - `occurredAt` — when it physically arrived.
 */
export const receiveStockRequestSchema = z
  .object({
    operationId: operationIdSchema,
    variantId: idSchema,
    locationId: idSchema,
    /**
     * Whole units, strictly positive.
     *
     * Zero is not a delivery, a negative number is a removal wearing a
     * receipt's name, and a fraction is a data-integrity defect this ledger
     * cannot represent — quantities are integer base units everywhere, in the
     * columns as well as the contracts. Bounded by the database's own integer
     * ceiling so an unstorable quantity is a `400` rather than a `500`.
     */
    quantity: z
      .number()
      .int('quantity must be a whole number of units')
      .positive('quantity must be greater than zero')
      .max(MAX_MOVEMENT_QUANTITY),
    occurredAt: occurredAtSchema,
  })
  .strict();

export type ReceiveStockRequest = z.infer<typeof receiveStockRequestSchema>;

/**
 * The result of receiving: which command this answers, the movement it
 * produced, and what the shelf holds now.
 *
 * The shared `movementResultSchema`, under the name receiving's callers already
 * use. It is the same three fields removal answers with, and they are the same
 * three for the same reason — so they are written once. `quantityAfter` carries
 * the posting engine's own name for the resulting balance rather than a second
 * name for one number.
 *
 * A retry of the same command returns this same body, with the same
 * `movementId`: replaying is answered, not re-posted.
 */
export const receiveStockResponseSchema = movementResultSchema;

export type ReceiveStockResponse = MovementResult;
