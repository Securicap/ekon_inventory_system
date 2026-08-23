import { z } from 'zod';

/**
 * Catalog contracts — Ekon's retail merchandise model as it crosses the wire.
 * Shared so the backend and the UI agree on one definition and cannot drift.
 *
 *     Classification → Product → Variant / SKU → SKU × Location
 *
 * A **product** is the recognizable model the customer names, and carries no
 * stock: a brand, a description, and how the merchandise is classified. A
 * **variant** is the smallest independently sellable and stockable identity, and
 * owns its own SKU, price, cost, barcodes, and inventory. Every product has at
 * least one — a plain item sold one way is a single default variant with no
 * attributes.
 *
 * See `docs/03-architecture/retail-domain-and-or1.md` and ADR 11.
 */

/** Enforced maximum product name length. Long enough for a real name, bounded. */
export const PRODUCT_NAME_MAX_LENGTH = 200;

/** Bounds on optional free text and on a single attribute name/value. */
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 2000;
export const ATTRIBUTE_NAME_MAX_LENGTH = 60;
export const ATTRIBUTE_VALUE_MAX_LENGTH = 120;

/** Bounds mirroring the columns in migration 0009. */
export const BRAND_NAME_MAX_LENGTH = 120;
export const CLASSIFICATION_VALUE_MAX_LENGTH = 80;
export const BARCODE_MAX_LENGTH = 64;

/**
 * SKUs are `EKN-` followed by eight uppercase, non-semantic characters. The
 * suffix is generated server-side; the client can never choose it.
 */
export const SKU_PATTERN = /^EKN-[0-9A-Z]{8}$/;

/**
 * A classification dimension's stable machine handle — `audience`, `category`,
 * `type`. Identical to `classification_dimensions_key_format` (0009). Requests
 * name dimensions by key, never by id: an operator knows "category", and nobody
 * knows a uuid.
 */
export const CLASSIFICATION_DIMENSION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * An uppercase three-letter currency code, in the ISO 4217 shape. Deliberately
 * a shape and not a list, exactly as the database constrains it (INV-17):
 * which currencies the business accepts must not require a release to change.
 */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * A barcode carries no whitespace anywhere. Stricter than the database's
 * `[[:space:]]` check only in that JavaScript's `\s` also covers a non-breaking
 * space, which is the safe direction for a client-side rule.
 */
export const BARCODE_PATTERN = /^\S+$/;

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

/**
 * Money: a whole number of **minor units** and the currency they are in.
 *
 * Never a float and never a bare number. Minor units because 2 499,00 HTG is
 * 249900 centimes, and a decimal price in a system that also computes margins
 * is a rounding argument waiting to happen. The currency is explicit because
 * this shop routinely buys in one and sells in another.
 *
 * Bounded at `Number.MAX_SAFE_INTEGER`: the column is `bigint`, and
 * `platform/db/pool.ts` parses it to a JavaScript number on the documented
 * assumption that amounts stay below 2^53 — about 90 trillion HTG in centimes.
 * The bound here is what keeps that assumption from being quietly broken by a
 * request rather than discovered later in a total.
 */
export const moneySchema = z
  .object({
    amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(CURRENCY_PATTERN, 'Currency must be a three-letter uppercase code'),
  })
  .strict();

export type Money = z.infer<typeof moneySchema>;

/**
 * Merchandise lifecycle (ADR 11). `DISCONTINUED` means no longer replenished —
 * existing stock is still sold and still counted. `ARCHIVED` means out of
 * day-to-day operation, retained for history.
 *
 * **A quantity reaching zero is not a lifecycle change.** Selling the last unit
 * is a fact about a shelf; discontinuing is a decision about merchandise.
 */
export const LIFECYCLE_STATUSES = ['ACTIVE', 'DISCONTINUED', 'ARCHIVED'] as const;

export const lifecycleStatusSchema = z.enum(LIFECYCLE_STATUSES);

export type LifecycleStatus = z.infer<typeof lifecycleStatusSchema>;

export const variantAttributeSchema = z.object({
  /** Normalized attribute name (trimmed and lower-cased), from the controlled vocabulary. */
  name: z.string(),
  /** Attribute value, trimmed; case preserved. */
  value: z.string(),
});

export type VariantAttribute = z.infer<typeof variantAttributeSchema>;

/** A brand, as merchandise names it. Display case is the shop's; identity is not. */
export const brandSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export type Brand = z.infer<typeof brandSchema>;

/**
 * One classification of a product: which dimension, and which controlled value.
 *
 * Classification groups merchandise; it is **not** variant variation. `Sandals`
 * produces no sellable identity, `Size 8` does, and the two live in different
 * places for that reason.
 */
export const productClassificationSchema = z.object({
  /** The dimension's stable key — `audience`, `category`, `type`. */
  dimension: z.string(),
  /** The dimension's display name, as the shop entered it. */
  dimensionName: z.string(),
  /** The controlled value, in its display case. */
  value: z.string(),
});

export type ProductClassification = z.infer<typeof productClassificationSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * One variant in a create-product request.
 *
 * `attributes` is a plain object of name → value; an empty object is valid and
 * means "the default variant". **Attribute names are controlled** — they must
 * already exist in the catalog's vocabulary, and an unknown one is a
 * `VALIDATION_FAILED` rather than a new definition created by a typo. Values
 * are free display text.
 *
 * Price, cost, and barcodes are optional because a shop entering merchandise it
 * has not priced yet is the ordinary case, and `null` is an honest answer that
 * a zero would not be.
 *
 * `.strict()` rejects any other field — in particular a client-supplied `id`,
 * `sku`, `variantSignature`, `lifecycleStatus`, or timestamp, every one of
 * which is the server's.
 */
export const createProductVariantSchema = z
  .object({
    attributes: z.record(z.string(), z.string()).default({}),
    sellingPrice: moneySchema.nullish(),
    referenceCost: moneySchema.nullish(),
    barcodes: z
      .array(
        z
          .string()
          .min(1, 'A barcode must not be blank')
          .max(BARCODE_MAX_LENGTH)
          .regex(BARCODE_PATTERN, 'A barcode must not contain whitespace'),
      )
      .default([])
      .refine(
        (codes) => new Set(codes).size === codes.length,
        'The same barcode is listed twice on one variant',
      ),
  })
  .strict();

export type CreateProductVariantInput = z.infer<typeof createProductVariantSchema>;

/**
 * A create-product request.
 *
 * Structural validation only. Whether a brand already exists, whether a
 * classification dimension is known, and whether an attribute name is in the
 * vocabulary are questions about the catalog's own data, so the module answers
 * them and produces field-level `VALIDATION_FAILED` details.
 *
 * `brand` is a **name**, not an id: the person entering merchandise knows
 * "Steve Madden" and could not know a uuid. The service resolves it against the
 * existing brands case-insensitively and creates it only if it is genuinely new,
 * inside the same transaction as the product.
 *
 * `classifications` is keyed by dimension key, which is what gives a product at
 * most one value per dimension for free — a JSON object cannot repeat a key. Not
 * every dimension has to be supplied; merchandise nobody has classified yet is a
 * real state.
 *
 * New merchandise always begins `ACTIVE`, so lifecycle is not a request field.
 */
export const createProductRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'Product name is required').max(PRODUCT_NAME_MAX_LENGTH),
    description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX_LENGTH).optional(),
    brand: z.string().trim().min(1, 'Brand must not be blank').max(BRAND_NAME_MAX_LENGTH).nullish(),
    classifications: z
      .record(
        z.string().regex(CLASSIFICATION_DIMENSION_KEY_PATTERN, 'Unknown classification dimension'),
        z
          .string()
          .trim()
          .min(1, 'A classification value must not be blank')
          .max(CLASSIFICATION_VALUE_MAX_LENGTH),
      )
      .default({}),
    variants: z
      .array(createProductVariantSchema)
      .min(1, 'A product must have at least one variant'),
  })
  .strict();

export type CreateProductRequest = z.infer<typeof createProductRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const productVariantSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  sku: z.string().regex(SKU_PATTERN),
  /** Attributes ordered deterministically by normalized name. */
  attributes: z.array(variantAttributeSchema),
  /** `null` when nobody has established one yet. Never a zero standing in for unknown. */
  sellingPrice: moneySchema.nullable(),
  /**
   * A reference figure for what the variant costs to acquire. **Not inventory
   * valuation and not profit accounting** — one mutable number that does not
   * know which units on the shelf came from which purchase (INV-17).
   */
  referenceCost: moneySchema.nullable(),
  /**
   * External identifiers attached to this SKU, ordered. A barcode never replaces
   * the SKU: it is somebody else's identifier, may be absent, and may legitimately
   * be shared with unrelated goods (INV-13).
   */
  barcodes: z.array(z.string()),
  lifecycleStatus: lifecycleStatusSchema,
  /**
   * **Stockability, and the only flag that governs it today.** Distinct from
   * `lifecycleStatus`, which is merchandise policy and is inert until PR 5
   * builds the lifecycle workflow and resolves the two into one.
   */
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProductVariant = z.infer<typeof productVariantSchema>;

export const productSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /** `null` for merchandise migrated before brands existed, and never guessed from a name. */
  brand: brandSchema.nullable(),
  /** Ordered by dimension key. Empty for merchandise nobody has classified yet. */
  classifications: z.array(productClassificationSchema),
  lifecycleStatus: lifecycleStatusSchema,
  /** See `ProductVariant.isActive`: the stockability bridge, not the lifecycle. */
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

// ---------------------------------------------------------------------------
// Merchandise vocabulary
// ---------------------------------------------------------------------------

/**
 * What the catalog already knows, so a screen can offer it rather than ask
 * somebody to type it and be refused.
 *
 * One bounded read rather than an endpoint per vocabulary: these are three small
 * lists that are always wanted together, by the one form that needs them. It is
 * deliberately **read-only** — brands and classification values are created as a
 * side effect of entering merchandise, and attribute names are structure that
 * grows by migration until there is a workflow to grow it.
 */
export const classificationDimensionSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** The controlled values defined under this dimension, ordered by value. */
  values: z.array(z.object({ id: z.string().uuid(), value: z.string() })),
});

export type ClassificationDimension = z.infer<typeof classificationDimensionSchema>;

export const variantAttributeDefinitionSchema = z.object({
  id: z.string().uuid(),
  /** The normalized name, exactly as `variant_attributes.attribute_name` stores it. */
  name: z.string(),
});

export type VariantAttributeDefinition = z.infer<typeof variantAttributeDefinitionSchema>;

export const catalogMetadataResponseSchema = z.object({
  brands: z.array(brandSchema),
  classificationDimensions: z.array(classificationDimensionSchema),
  variantAttributeDefinitions: z.array(variantAttributeDefinitionSchema),
});

export type CatalogMetadataResponse = z.infer<typeof catalogMetadataResponseSchema>;
