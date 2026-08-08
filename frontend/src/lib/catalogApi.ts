import {
  createProductRequestSchema,
  createProductResponseSchema,
  type CreateProductRequest,
  type Product,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * Creating a product: one call, over the one API client.
 *
 * **No operation id, and deliberately so.** `postWithoutOperationId` is for
 * calls that are not ledger commands, and this is one — the header exists so a
 * retried *movement* posts once, and `POST /api/catalog/products` writes no
 * `operations` row. Sending it would claim an idempotency the route does not
 * implement.
 *
 * Which is exactly why nothing retries this automatically. A receipt may be
 * pressed again after a dropped connection because the server recognizes the
 * repeat; a product may not, because a second attempt after an uncertain answer
 * is a second product. The screen offers the person the choice and says why —
 * see `NewProductForm`.
 */
export async function createProduct(request: CreateProductRequest): Promise<Product> {
  /**
   * Parsed with the *shared* request schema before it goes anywhere — the same
   * one the route parses, so the browser and the server cannot disagree about
   * what a product is. Being `.strict()`, it also refuses to put a server-owned
   * field on the wire: no id, no `variantSignature`, and above all no `sku`,
   * which is generated server-side and can never be chosen by a caller.
   */
  const body = createProductRequestSchema.parse(request);

  const response = await api.postWithoutOperationId<unknown>('/api/catalog/products', body);

  /**
   * And parsed on the way back rather than asserted with a type parameter, the
   * way `usersApi.ts` and `inventoryQueries.ts` parse theirs. The reply is what
   * the screen confirms a product by — and what it reads the generated SKUs
   * from — so a server answering something unexpected should fail loudly here
   * rather than render a confident blank.
   */
  return createProductResponseSchema.parse(response);
}
