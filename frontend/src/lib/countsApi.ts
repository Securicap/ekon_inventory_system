import {
  countPageSchema,
  countRecordSchema,
  recordCountRequestSchema,
  reconcileCountRequestSchema,
  type CountPage,
  type CountRecord,
  type CountStatus,
  type RecordCountRequest,
  type ReconcileCountRequest,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * Physical counts over the wire, and the names the cache knows them by.
 *
 * Two commands and one read, and the difference between the two commands is the
 * whole workflow: recording an observation changes no stock, and reconciling
 * one does. What that means for this file is only that both carry an operation
 * id — a count moves nothing, but it is durable evidence, and a dropped
 * connection must not leave two records of one shelf-check.
 */

/**
 * The count feed, keyed by the filters it was read with.
 *
 * Filters are part of the key rather than of the component's state alone,
 * because two different questions — *everything*, and *what is still open* —
 * are two different answers and must not share a cache entry. Home reads the
 * open list; the Counts screen reads whichever the person is looking at.
 */
export function countsQueryKey(filters: CountFilters = {}) {
  return ['inventory', 'counts', filters] as const;
}

/** Everything under `['inventory', 'counts']`, whatever the filters. */
export const countsQueryPrefix = ['inventory', 'counts'] as const;

export interface CountFilters {
  status?: CountStatus | undefined;
  variantId?: string | undefined;
  locationId?: string | undefined;
}

/**
 * `GET /api/inventory/counts` — one page of count evidence, newest first.
 *
 * The cursor is a parameter rather than part of the key: a "load more" appends
 * to what is already on screen, so the pages of one filter belong to one cache
 * entry. See `useCountFeed`.
 */
export async function getCounts(
  filters: CountFilters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<CountPage> {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.variantId) query.set('variantId', filters.variantId);
  if (filters.locationId) query.set('locationId', filters.locationId);
  if (cursor) query.set('cursor', cursor);

  const response = await api.get<unknown>(`/api/inventory/counts?${query.toString()}`, signal);
  return countPageSchema.parse(response);
}

/**
 * `POST /api/inventory/counts` — what somebody physically saw.
 *
 * Parsed with the shared request schema before it goes anywhere, which is what
 * refuses to put `expectedQuantity` on the wire even if a screen somehow tried:
 * the expected quantity is the server's, read inside its own transaction, and a
 * browser that could supply it could manufacture any variance it liked.
 */
export async function recordCount(request: RecordCountRequest): Promise<CountRecord> {
  const body = recordCountRequestSchema.parse(request);
  const response = await api.post<unknown>('/api/inventory/counts', body, body.operationId);
  return countRecordSchema.parse(response);
}

/**
 * `POST /api/inventory/counts/:countId/reconcile` — accepting a difference.
 *
 * The count id is in the path and the decision is in the body. Everything about
 * *what moves* — the variant, the location, the delta — comes from the stored
 * count, so there is nothing here for a caller to state wrongly, and the
 * `.strict()` schema refuses it if one tried.
 */
export async function reconcileCount(
  countId: string,
  request: ReconcileCountRequest,
): Promise<CountRecord> {
  const body = reconcileCountRequestSchema.parse(request);
  const response = await api.post<unknown>(
    `/api/inventory/counts/${countId}/reconcile`,
    body,
    body.operationId,
  );
  return countRecordSchema.parse(response);
}
