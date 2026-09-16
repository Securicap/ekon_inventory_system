import {
  adjustStockRequestSchema,
  adjustStockResponseSchema,
  type AdjustStockRequest,
  type AdjustStockResponse,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * Correcting a recorded quantity: one call, over the one API client.
 *
 * The request carries a **signed** delta, which the form built from a direction
 * and a magnitude (`lib/adjustment.ts`). It carries no movement type: the server
 * derives `ADJUSTMENT_IN` or `ADJUSTMENT_OUT` from the sign, and the shared
 * schema refuses a body that tried to name one — which is what stops a screen
 * ever posting an increase that removed stock.
 *
 * It is not receiving and it is not removal, and the separation is the point.
 * Those two say stock physically moved; this says the number was wrong. They
 * are different capabilities on the server and different screens here.
 */
export async function adjustStock(request: AdjustStockRequest): Promise<AdjustStockResponse> {
  const body = adjustStockRequestSchema.parse(request);
  const response = await api.post<unknown>('/api/inventory/adjust', body, body.operationId);
  return adjustStockResponseSchema.parse(response);
}
