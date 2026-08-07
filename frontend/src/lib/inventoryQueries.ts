import {
  listInventoryBalancesResponseSchema,
  type ListInventoryBalancesResponse,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * The current-stock read, and the one name the cache knows it by.
 *
 * The key lives here rather than inside the screen because two screens depend
 * on it meaning the same thing: the stock screen reads it, and receiving
 * invalidates it after the server confirms a delivery. Invalidation matches on
 * key equality, so two literals written out separately would drift apart
 * silently — the receipt would succeed, the numbers would stay stale, and
 * nothing would fail.
 *
 * Receiving imports this module, not the stock screen. A write that had to pull
 * in a screen component to find out what to invalidate would be a dependency
 * pointing the wrong way.
 */
export const inventoryBalancesQueryKey = ['inventory', 'balances'] as const;

/**
 * `GET /api/inventory/balances` — every active variant, and its quantity at
 * every active location.
 *
 * Parsed with the shared response schema rather than asserted with a type
 * parameter, the way `receivingApi.ts` parses its response. These numbers are
 * what an employee is about to be told is on the shelf, so a server answering
 * something unexpected should fail loudly here rather than render a confident
 * blank — and the schema is `.strict()`, so a ledger field that leaked into the
 * response would be refused rather than quietly displayed.
 *
 * This is the whole of what the stock screen fetches. The response already
 * carries the product name, the SKU, the attributes, and every location's name,
 * so there is no second read of the catalog and no read of the location list.
 */
export async function getInventoryBalances(
  signal: AbortSignal,
): Promise<ListInventoryBalancesResponse> {
  const response = await api.get<unknown>('/api/inventory/balances', signal);
  return listInventoryBalancesResponseSchema.parse(response);
}
