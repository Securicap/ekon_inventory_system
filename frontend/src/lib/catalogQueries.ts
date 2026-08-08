import type { ListProductsResponse } from '@ekon/shared';
import { api } from './api.js';

/**
 * The catalog read, and the one name the cache knows it by.
 *
 * The key lives here rather than inside a screen because three places now
 * depend on it meaning the same thing: the catalog screen lists products,
 * receiving builds its variant choices from the same read, and creating a
 * product invalidates it so both see the new one. Invalidation matches on key
 * equality, so literals written out separately would drift apart silently — the
 * product would be created, the list would stay stale, and nothing would fail.
 *
 * The same arrangement `inventoryQueries.ts` already uses for balances, for the
 * same reason. A write that had to import a screen component to find out what
 * to invalidate would be a dependency pointing the wrong way.
 */
export const catalogProductsQueryKey = ['catalog', 'products'] as const;

/** `GET /api/catalog/products` — every product, with its variants. */
export function getCatalogProducts(signal: AbortSignal): Promise<ListProductsResponse> {
  return api.get<ListProductsResponse>('/api/catalog/products', signal);
}
