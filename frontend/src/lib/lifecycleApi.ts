import {
  productSchema,
  productVariantSchema,
  updateLifecycleRequestSchema,
  type LifecycleStatus,
  type Product,
  type ProductVariant,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * Withdrawing merchandise, and bringing it back.
 *
 * `PATCH` with a state rather than `POST` with a verb: the body says what the
 * merchandise should be, so pressing the button twice leaves what pressing it
 * once left. There is no operation id because there is nothing to be idempotent
 * about — a declarative assignment already is.
 *
 * Neither call moves stock, and neither may. If archiving is refused because
 * the merchandise still holds some, that is a `409` the screen shows; it is
 * emphatically not an invitation for this application to write the stock off
 * first.
 */
export async function setProductLifecycle(
  productId: string,
  lifecycleStatus: LifecycleStatus,
): Promise<Product> {
  const body = updateLifecycleRequestSchema.parse({ lifecycleStatus });
  const response = await api.patch<unknown>(`/api/catalog/products/${productId}/lifecycle`, body);
  return productSchema.parse(response);
}

export async function setVariantLifecycle(
  variantId: string,
  lifecycleStatus: LifecycleStatus,
): Promise<ProductVariant> {
  const body = updateLifecycleRequestSchema.parse({ lifecycleStatus });
  const response = await api.patch<unknown>(`/api/catalog/variants/${variantId}/lifecycle`, body);
  return productVariantSchema.parse(response);
}
