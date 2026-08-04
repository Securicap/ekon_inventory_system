import {
  receiveStockRequestSchema,
  receiveStockResponseSchema,
  type ReceiveStockRequest,
  type ReceiveStockResponse,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * Booking in stock that arrived: one call, over the one API client.
 *
 * There is no receiving-specific HTTP here — no fetch, no headers, no
 * credentials, no error translation. `lib/api.ts` owns all of that, including
 * `credentials: 'same-origin'` that carries the session cookie and the
 * structured `ApiError` a screen renders. This file is the *typed shape* of one
 * endpoint and nothing else.
 *
 * It does not generate the operation id, and it must not. The id identifies the
 * intent, which outlives any single call: minting one here would give every
 * retry a new identity and turn the server's duplicate protection off from the
 * outside. The caller owns it and passes the same one back for a retry.
 */
export async function receiveStock(request: ReceiveStockRequest): Promise<ReceiveStockResponse> {
  /**
   * Parsed with the shared request schema before it goes anywhere — the same
   * schema the route parses, so the browser and the server cannot disagree
   * about what a receipt is. It is strict, so this also refuses to put a field
   * on the wire that the server owns: a `userId`, a `movementId`, a
   * `requestHash`. The screen validates fields for the person; this validates
   * the *request*, at the last point where it is still ours.
   */
  const body = receiveStockRequestSchema.parse(request);

  const response = await api.post<unknown>('/api/inventory/receive', body, body.operationId);

  /**
   * And parsed on the way back, rather than asserted with a type parameter. The
   * balance in this response is what an employee is about to be told is on the
   * shelf, so a server that answered something unexpected should fail loudly
   * here instead of rendering a confident blank.
   */
  return receiveStockResponseSchema.parse(response);
}
