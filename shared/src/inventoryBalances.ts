import { z } from 'zod';
import { SKU_PATTERN, variantAttributeSchema } from './catalog.js';
import { idSchema, quantitySchema } from './movements.js';

/**
 * Current stock contracts — how many units of each variant are held where,
 * right now.
 *
 * This is an **operational current-state view**, not history and not a report.
 * It answers the one question the counter asks all day: *what do we have, and
 * where is it?* The ledger remains the record of how the numbers got there, and
 * nothing in this contract exposes any of it.
 *
 * `inventory_balances.quantity_on_hand` is the authoritative current-stock
 * projection, and this response is that projection presented per variant. Stock
 * is never recalculated by summing movements to answer a read.
 *
 * Read-only, and there are no query parameters in this first version — no
 * pagination, filter, sort, or search. The response is the whole active picture,
 * which for a single shop is a small, bounded matrix.
 */

/**
 * What one variant holds at one location.
 *
 * Every active location appears for every active variant, whether or not that
 * shelf has ever held stock, so a screen can render the full grid without
 * inferring the gaps. That completeness is what forces the distinction below.
 */
export const variantLocationBalanceSchema = z
  .object({
    locationId: idSchema,
    locationName: z.string(),
    /** True for the default location; it is returned first within each variant. */
    isDefault: z.boolean(),
    /** Whole units on hand. Never negative, never fractional. */
    quantity: quantitySchema,
    /**
     * When the balance projection for this (variant, location) last moved — or
     * `null` when **no balance row exists at all**, which is a shelf that has
     * never held stock.
     *
     * The two zeroes are deliberately distinguishable. A row with `quantity: 0`
     * and a timestamp is stock that came and went; `quantity: 0` with `null` is
     * stock that was never there. Substituting the current time, or the
     * product's or location's own `updated_at`, would erase that difference and
     * invent a moment nothing happened at.
     */
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

export type VariantLocationBalance = z.infer<typeof variantLocationBalanceSchema>;

/**
 * One active variant, and what it holds across every active location.
 *
 * `.strict()` on purpose. The ledger's own fields — movement ids, operation ids,
 * the last movement pointer, `quantity_before`/`quantity_after`, user ids,
 * request hashes — are not merely absent from this schema but refused by it, so
 * a leak is a failing contract test rather than something a reviewer has to
 * notice. `variantSignature` is refused for the same reason: it is an internal
 * fingerprint, and a current-stock screen has no use for it.
 */
export const variantStockBalanceSchema = z
  .object({
    variantId: idSchema,
    productId: idSchema,
    /** The product's name, so a screen needs no second lookup to label a row. */
    productName: z.string(),
    sku: z.string().regex(SKU_PATTERN),
    /** The variant's attributes, in the catalog's existing deterministic order. */
    attributes: z.array(variantAttributeSchema),
    /**
     * The sum of `locations[].quantity`, computed in the response mapping.
     *
     * Deliberately not a stored column and not a second query: a total kept
     * anywhere other than in the numbers it totals is a number that can disagree
     * with them.
     */
    totalQuantity: quantitySchema,
    /**
     * One entry per **active** location, default first. Empty only when the
     * business has no active location at all — which is an operational problem
     * for a screen to surface, not a server error.
     */
    locations: z.array(variantLocationBalanceSchema),
  })
  .strict();

export type VariantStockBalance = z.infer<typeof variantStockBalanceSchema>;

/**
 * `GET /api/inventory/balances`.
 *
 * A plain array of every active variant. No active variants is an empty array,
 * never an error and never a null.
 */
export const listInventoryBalancesResponseSchema = z.array(variantStockBalanceSchema);

export type ListInventoryBalancesResponse = z.infer<typeof listInventoryBalancesResponseSchema>;
