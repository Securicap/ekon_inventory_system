import {
  movementHistoryPageSchema,
  reverseMovementRequestSchema,
  reverseMovementResponseSchema,
  type MovementHistoryPage,
  type MovementType,
  type ReverseMovementRequest,
  type ReverseMovementResponse,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * The ledger, read — and the one command that writes to it without describing a
 * business event of its own.
 */

/** Everything under `['inventory', 'movements']`, whatever the filters. */
export const movementsQueryPrefix = ['inventory', 'movements'] as const;

export function movementsQueryKey(filters: MovementFilters = {}) {
  return ['inventory', 'movements', filters] as const;
}

export interface MovementFilters {
  variantId?: string | undefined;
  locationId?: string | undefined;
  movementType?: MovementType | undefined;
}

/**
 * `GET /api/inventory/movements` — one page of history, newest recorded first.
 *
 * Cursor-paginated, never offset: the ledger grows at the front, and a page
 * number over a growing list shows somebody the same movement twice or skips
 * one entirely. The cursor is passed rather than keyed, so successive pages of
 * one filter accumulate into one cache entry.
 */
export async function getMovements(
  filters: MovementFilters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<MovementHistoryPage> {
  const query = new URLSearchParams();
  if (filters.variantId) query.set('variantId', filters.variantId);
  if (filters.locationId) query.set('locationId', filters.locationId);
  if (filters.movementType) query.set('movementType', filters.movementType);
  if (cursor) query.set('cursor', cursor);

  const response = await api.get<unknown>(`/api/inventory/movements?${query.toString()}`, signal);
  return movementHistoryPageSchema.parse(response);
}

/**
 * `POST /api/inventory/reverse` — undoing one movement by appending its
 * compensation.
 *
 * The request names a movement and nothing about the stock: the variant, the
 * location, the quantity and the direction all come from the original row. A
 * screen could not send them if it wanted to — the shared schema refuses each
 * one — which is what makes "reverse this" a safe thing to put behind a button.
 */
export async function reverseMovement(
  request: ReverseMovementRequest,
): Promise<ReverseMovementResponse> {
  const body = reverseMovementRequestSchema.parse(request);
  const response = await api.post<unknown>('/api/inventory/reverse', body, body.operationId);
  return reverseMovementResponseSchema.parse(response);
}
