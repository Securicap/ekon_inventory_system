import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';

/**
 * Reading the balance projection.
 *
 * `inventory_balances` is written in exactly one place — `ledgerRepository.ts`,
 * inside the posting transaction, under a row lock — and that has not changed.
 * This file is the other half: the read side, which takes no lock, opens no
 * transaction, and creates nothing.
 *
 * It is kept apart from the posting engine's repository on purpose. Every
 * function there takes a transaction client because a movement and its balance
 * must commit together; a plain `SELECT` for a screen sitting among them would
 * invite the next reader to assume it belongs to that transaction, or the next
 * writer to reach for a pool-level variant of something that must never have
 * one. Different guarantees, different file.
 *
 * **Current stock is never summed from the ledger.** `quantity_on_hand` is the
 * authoritative projection, maintained atomically with every movement, and this
 * reads it as it stands.
 */

/** Read-only access: the pool, or a transaction already in progress. */
type Queryable = DatabasePool | DatabaseClient;

/**
 * One (variant, location) shelf that has a balance row.
 *
 * The *absence* of one of these is meaningful and is why nothing here invents a
 * zero: a shelf with no row has never held stock, and only the caller composing
 * the full matrix knows which shelves it expected to find.
 */
export interface BalanceProjection {
  variantId: string;
  locationId: string;
  quantityOnHand: number;
  /** When this projection last moved. Never null: the column is `NOT NULL`. */
  updatedAt: Date;
}

/**
 * Every balance row belonging to the given variants, in one query.
 *
 * Narrowed to the variants asked about rather than reading the whole table, so
 * a catalog that has retired half its items does not pay for their history on
 * every stock read. The result is indexed by the caller, so no ordering is
 * imposed here — the order of the response comes from the variant and location
 * lists it is composed against, not from this.
 *
 * An ordinary non-locking read at the connection's isolation level. It sees one
 * committed snapshot: a concurrent receipt is either wholly visible or not
 * visible at all, because the movement and its balance commit together.
 */
export async function listBalancesForVariants(
  db: Queryable,
  variantIds: string[],
): Promise<BalanceProjection[]> {
  if (variantIds.length === 0) return [];

  const { rows } = await db.query<{
    variant_id: string;
    location_id: string;
    quantity_on_hand: number;
    updated_at: Date;
  }>(
    `SELECT variant_id, location_id, quantity_on_hand, updated_at
       FROM inventory_balances
      WHERE variant_id = ANY($1)`,
    [variantIds],
  );

  return rows.map((row) => ({
    variantId: row.variant_id,
    locationId: row.location_id,
    quantityOnHand: row.quantity_on_hand,
    updatedAt: row.updated_at,
  }));
}

/**
 * One variant's total on-hand quantity, summed across every location.
 *
 * The shape the catalog's archive check needs: it asks whether merchandise
 * holds stock *anywhere*, not where. Which shelf it is on is an operational
 * question and would not change the answer — archiving is refused either way.
 */
export interface VariantStockTotal {
  variantId: string;
  quantityOnHand: number;
}

/**
 * Which of the given variants currently hold stock, and how much in total.
 *
 * **One statement for any number of variants**, aggregated in the database
 * rather than by summing rows in memory: archiving a product with forty SKUs
 * asks one question, not forty. Variants holding nothing are absent from the
 * result — `HAVING SUM(...) > 0` — because the caller's question is "which of
 * these block the archive", and rows of zero would be an answer it would only
 * have to filter again.
 *
 * Deliberately reads the **projection** and never sums `inventory_movements`.
 * `quantity_on_hand` is the authoritative current quantity, maintained
 * atomically with every movement (INV-6); summing the ledger would read a
 * moving target and would get slower for every movement the shop ever posts.
 *
 * Takes a transaction client rather than the pool, and that is not incidental.
 * Its one caller is the lifecycle service's archive check, which has already
 * locked the catalog rows this variant's writers must pass through; running
 * this on a separate connection would answer about a different moment and the
 * archive would be checking stock it no longer had a lock on. No pool-level
 * variant exists, and none should.
 */
export async function findVariantsHoldingStock(
  tx: DatabaseClient,
  variantIds: string[],
): Promise<VariantStockTotal[]> {
  if (variantIds.length === 0) return [];

  const { rows } = await tx.query<{ variant_id: string; quantity_on_hand: number }>(
    `SELECT variant_id, SUM(quantity_on_hand)::int AS quantity_on_hand
       FROM inventory_balances
      WHERE variant_id = ANY($1)
      GROUP BY variant_id
     HAVING SUM(quantity_on_hand) > 0
      ORDER BY variant_id`,
    [variantIds],
  );

  return rows.map((row) => ({
    variantId: row.variant_id,
    quantityOnHand: row.quantity_on_hand,
  }));
}
