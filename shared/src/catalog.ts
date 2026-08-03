import { z } from 'zod';

/**
 * Catalog contracts — the shape of products, variants, and their attributes as
 * they cross the wire. Shared so the backend and a future React UI agree on one
 * definition and cannot drift apart.
 *
 * A product is the general item the business sells. Stock is always held per
 * *variant*, never against the product directly, so every product has at least
 * one variant — a plain item with no attributes is a single default variant.
 */

/** Enforced maximum product name length. Long enough for a real name, bounded. */
export const PRODUCT_NAME_MAX_LENGTH = 200;

/** Bounds on optional free text and on a single attribute name/value. */
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 2000;
export const ATTRIBUTE_NAME_MAX_LENGTH = 60;
export const ATTRIBUTE_VALUE_MAX_LENGTH = 120;

/**
 * SKUs are `EKN-` followed by eight uppercase, non-semantic characters. The
 * suffix is generated server-side; the client can never choose it.
 */
export const SKU_PATTERN = /^EKN-[0-9A-Z]{8}$/;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * One variant in a create-product request. `attributes` is a plain object of
 * name -> value; an empty object is valid and means "the default variant".
 *
 * `.strict()` rejects any other field — in particular it refuses a
 * client-supplied `sku` or `id`, both of which are assigned by the server.
 */
export const createProductVariantSchema = z
  .object({
    attributes: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export type CreateProductVariantInput = z.infer<typeof createProductVariantSchema>;

/**
 * A create-product request. Structural validation only — name is required and
 * bounded, there must be at least one variant. Semantic normalization of
 * attributes (trimming, name normalization, duplicate detection) happens in the
 * catalog module and produces field-level `VALIDATION_FAILED` details.
 */
export const createProductRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'Product name is required').max(PRODUCT_NAME_MAX_LENGTH),
    description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX_LENGTH).optional(),
    variants: z
      .array(createProductVariantSchema)
      .min(1, 'A product must have at least one variant'),
  })
  .strict();

export type CreateProductRequest = z.infer<typeof createProductRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const variantAttributeSchema = z.object({
  /** Normalized attribute name (trimmed and lower-cased). */
  name: z.string(),
  /** Attribute value, trimmed; case preserved. */
  value: z.string(),
});

export type VariantAttribute = z.infer<typeof variantAttributeSchema>;

export const productVariantSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  sku: z.string().regex(SKU_PATTERN),
  /** Deterministic fingerprint of the normalized attribute set. */
  variantSignature: z.string(),
  isActive: z.boolean(),
  /** Attributes ordered deterministically by normalized name. */
  attributes: z.array(variantAttributeSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProductVariant = z.infer<typeof productVariantSchema>;

export const productSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  variants: z.array(productVariantSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Product = z.infer<typeof productSchema>;

/** A created product is returned in full, including server-generated SKUs. */
export const createProductResponseSchema = productSchema;

/** The catalog list is a plain array; an empty catalog is an empty array. */
export const listProductsResponseSchema = z.array(productSchema);

export type ListProductsResponse = z.infer<typeof listProductsResponseSchema>;
