import type { DatabaseClient } from '../../platform/db/pool.js';
import {
  findVariantsHoldingStock,
  type VariantStockTotal,
} from './infrastructure/balanceRepository.js';

/**
 * Whether merchandise currently holds stock — the one thing the catalog module
 * is allowed to ask this one about balances.
 *
 * It exists because of a boundary, and the boundary is worth stating. The
 * catalog owns merchandise lifecycle and refuses to archive anything that still
 * holds stock; inventory owns `inventory_balances`. Neither may read the
 * other's tables — the lint rule enforces it, and the reason it exists is that
 * a single cross-module join is how a modular monolith stops being one. So the
 * catalog declares the narrow question it has (`StockPresenceReader`) and this
 * is the inventory module's answer to it.
 *
 * **Read-only, in every sense that matters.** No transaction of its own, no
 * lock, no clock, no movement, no balance row created to answer a question. It
 * cannot change stock and has no path to anything that can.
 *
 * It deliberately does **not** grow into "the inventory module's API for other
 * modules". One question, one method, and a new question means a new named
 * method with its own reasoning rather than a `query(spec)` that would let any
 * module ask anything.
 */
export interface StockPresenceService {
  /**
   * Which of these variants hold stock right now, and how much across all
   * locations. Variants holding nothing are absent from the result.
   *
   * Takes the **caller's transaction client**, because the answer is only worth
   * anything inside the transaction that is about to act on it. The catalog's
   * archive check has already locked the merchandise rows every posting
   * workflow must pass through; reading balances on another connection would
   * answer about a different moment, and the check-then-act race this whole
   * arrangement exists to close would be back.
   */
  findVariantsHoldingStock(tx: DatabaseClient, variantIds: string[]): Promise<VariantStockTotal[]>;
}

export function createStockPresenceService(): StockPresenceService {
  return {
    findVariantsHoldingStock: (tx, variantIds) => findVariantsHoldingStock(tx, variantIds),
  };
}
