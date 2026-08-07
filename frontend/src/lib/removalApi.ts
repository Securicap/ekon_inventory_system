import {
  removeStockRequestSchema,
  removeStockResponseSchema,
  type RemoveStockRequest,
  type RemoveStockResponse,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * Recording stock that left: one call, over the one API client.
 *
 * The mirror of `receivingApi.ts`, and deliberately as small. There is no
 * removal-specific HTTP here — no fetch, no headers, no credentials, no error
 * translation. `lib/api.ts` owns all of that, including
 * `credentials: 'same-origin'` that carries the session cookie and the
 * structured `ApiError` a screen renders. This file is the *typed shape* of one
 * endpoint and nothing else.
 *
 * It does not generate the operation id, and it must not. The id identifies the
 * intent, which outlives any single call: minting one here would give every
 * retry a new identity and turn the server's duplicate protection off from the
 * outside. The caller owns it and passes the same one back for a retry.
 */
export async function removeStock(request: RemoveStockRequest): Promise<RemoveStockResponse> {
  /**
   * Parsed with the shared request schema before it goes anywhere — the same
   * schema the route parses, so the browser and the server cannot disagree
   * about what a removal is. It is strict, so this also refuses to put a field
   * on the wire that the server owns: a `userId`, a `movementId`, a
   * `quantityDelta`, a `reasonCode`. The screen validates fields for the
   * person; this validates the *request*, at the last point where it is still
   * ours.
   *
   * The quantity that goes out is positive. Direction belongs to the server's
   * workflow, and a browser that sent its own sign could add stock through an
   * endpoint whose capability says `remove`.
   */
  const body = removeStockRequestSchema.parse(request);

  const response = await api.post<unknown>('/api/inventory/remove', body, body.operationId);

  /**
   * And parsed on the way back, rather than asserted with a type parameter. The
   * balance in this response is what an employee is about to be told is left on
   * the shelf, so a server that answered something unexpected should fail
   * loudly here instead of rendering a confident blank.
   */
  return removeStockResponseSchema.parse(response);
}
