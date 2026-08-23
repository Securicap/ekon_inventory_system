import { createProductRequestSchema, type CreateProductRequest } from '@ekon/shared';

/**
 * A create-product request, built through the shared schema.
 *
 * Tests that call `CatalogService.createProduct` directly bypass the route, and
 * therefore bypass the parse the route performs. Going through the schema here
 * means a test exercises the same value a real request produces — defaults
 * applied, optional fields settled — rather than a hand-written object that
 * happens to satisfy the compiler but could never arrive over the wire.
 */
export function productRequest(
  overrides: Partial<Record<string, unknown>> = {},
): CreateProductRequest {
  return createProductRequestSchema.parse({
    name: 'Product',
    variants: [{ attributes: {} }],
    ...overrides,
  });
}
