import type {
  Brand,
  ClassificationDimension,
  LifecycleStatus,
  Money,
  Product,
  ProductClassification,
  ProductVariant,
  VariantAttribute,
  VariantAttributeDefinition,
} from '@ekon/shared';
import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';
import { AppError } from '../../../platform/http/errors.js';
import { OPERATIONAL_LIFECYCLE_STATUSES } from '../domain/lifecycle.js';
import type { NormalizedAttribute } from '../domain/variantSignature.js';

/**
 * Catalog persistence. Hand-written SQL, typed row shapes kept internal to the
 * backend, and mapping to the shared wire types done in one place.
 *
 * Anything that reads may run against the pool or a transaction client; every
 * write takes a transaction client, because a product is only ever created as
 * one atomic unit with its brand, classifications, variants, attributes, prices,
 * and barcodes.
 */

type Queryable = DatabasePool | DatabaseClient;

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  brand_id: string | null;
  brand_name: string | null;
  lifecycle_status: string;
  created_at: Date;
  updated_at: Date;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  lifecycle_status: string;
  /** `bigint`, parsed to a number by `platform/db/pool.ts` (INV-17). */
  selling_price_minor: number | null;
  selling_price_currency: string | null;
  reference_cost_minor: number | null;
  reference_cost_currency: string | null;
  created_at: Date;
  updated_at: Date;
}

interface AttributeRow {
  variant_id: string;
  attribute_name: string;
  attribute_value: string;
}

interface ClassificationRow {
  product_id: string;
  dimension_key: string;
  dimension_name: string;
  value: string;
}

interface BarcodeRow {
  variant_id: string;
  barcode: string;
}

/**
 * The lifecycle of one variant and of the product it belongs to, as read from
 * the two rows that carry it.
 *
 * Both statuses, unreduced. Combining them is
 * `domain/lifecycle.ts`'s job — a repository that returned only the effective
 * answer would be a repository holding business policy, and the two statuses
 * are separately meaningful to the service that reports why something was
 * refused.
 *
 * Not a wire type: it crosses a module boundary inside the backend, never the
 * network.
 */
export interface VariantLifecycle {
  id: string;
  /** The product this variant belongs to. The relationship, not a lookup. */
  productId: string;
  /** The variant's own stored status. */
  variantStatus: LifecycleStatus;
  /** Its parent product's, which is a ceiling on it. */
  productStatus: LifecycleStatus;
}

/**
 * A variant that is still part of day-to-day operations, as a module presenting
 * stock needs to label it: the identity, the product it belongs to, its SKU,
 * and the attributes that tell two variants of one product apart.
 *
 * Deliberately unchanged by the merchandise model. Price, cost, brand, and
 * classification are merchandise facts, and the stock view has no consumer for
 * any of them — widening this would couple the inventory module to the catalog's
 * whole model in exchange for fields nothing renders.
 *
 * Not a wire type either. It crosses a module boundary inside the backend; the
 * module that presents it owns the mapping to whatever crosses the network.
 */
export interface OperationalVariantListing {
  id: string;
  productId: string;
  /** The parent product's name. The relationship resolved, not a lookup. */
  productName: string;
  sku: string;
  /** Deterministically ordered by normalized attribute name, as everywhere else. */
  attributes: VariantAttribute[];
}

/**
 * A variant as **history** needs to name it, which is not the same question as
 * what may be stocked.
 *
 * `OperationalVariantListing` answers "what can we hold stock of today" and
 * therefore filters to active merchandise under active products. Evidence has
 * no business being filtered that way: a movement posted last year against a
 * variant the shop has since retired is exactly the record somebody goes
 * looking for, and a history that quietly omitted it would be worse than one
 * that refused to load.
 *
 * So this resolves any variant id, whatever its lifecycle, and returns no
 * status at all — a reader is being told what the merchandise *is*, not whether
 * it may be received into today.
 *
 * Deliberately narrow: identity, the product it belongs to, the brand, the SKU,
 * and the attributes that tell two variants apart. No price, no reference cost,
 * no classification, no barcode. None of them is evidence about a stock
 * movement, and each would widen what the inventory module depends on.
 */
export interface VariantLabel {
  id: string;
  productId: string;
  productName: string;
  /** `null` for merchandise nobody has given a brand. Never guessed from a name. */
  brandName: string | null;
  sku: string;
  attributes: VariantAttribute[];
}

export interface InsertProductParams {
  id: string;
  name: string;
  description: string | null;
  brandId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertVariantParams {
  id: string;
  productId: string;
  sku: string;
  variantSignature: string;
  sellingPrice: Money | null;
  referenceCost: Money | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClassificationAssignment {
  dimensionId: string;
  valueId: string;
}

/** A classification dimension as the service resolves requests against it. */
export interface DimensionRecord {
  id: string;
  key: string;
  name: string;
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Returns the name of the violated unique constraint when `error` is a Postgres
 * unique violation, otherwise null. Lets the caller distinguish an expected SKU
 * collision from a real failure without swallowing anything.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  ) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === 'string' ? constraint : '';
  }
  return null;
}

export const VARIANT_SKU_UNIQUE_CONSTRAINT = 'product_variants_sku_unique';
export const VARIANT_SIGNATURE_UNIQUE_CONSTRAINT = 'product_variants_signature_unique';

// ---------------------------------------------------------------------------
// Merchandise vocabulary
// ---------------------------------------------------------------------------

/**
 * Resolves a brand by its normalized name, creating it only if it is genuinely
 * new, and returns the row either way.
 *
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING`, then read — never
 * check-then-insert, which races. Two people entering the first two "Steve
 * Madden" products at the same moment must end up with one brand: the second
 * insert conflicts on `brands_normalized_name_unique`, returns nothing, and the
 * follow-up read finds what the first one committed. At `READ COMMITTED` the
 * insert waits on the conflicting index entry until that transaction finishes,
 * and the read that follows takes a fresh snapshot, so the row is there.
 *
 * The display case belongs to whoever created the brand first. `steve madden`
 * typed second does not rewrite `Steve Madden`, because a later request is not
 * evidence that an earlier one was wrong.
 */
export async function resolveBrand(
  tx: DatabaseClient,
  params: { id: string; name: string; normalizedName: string; now: Date },
): Promise<Brand> {
  await tx.query(
    `INSERT INTO brands (id, name, normalized_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (normalized_name) DO NOTHING`,
    [params.id, params.name, params.normalizedName, params.now],
  );

  const { rows } = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM brands WHERE normalized_name = $1`,
    [params.normalizedName],
  );
  const row = rows[0];
  // Unreachable: the insert above either created it or found it already there.
  if (!row) throw new Error(`Brand "${params.normalizedName}" vanished after being resolved`);
  return { id: row.id, name: row.name };
}

/** Every classification dimension, by its stable key. Ordered for determinism. */
export async function listDimensions(db: Queryable): Promise<DimensionRecord[]> {
  const { rows } = await db.query<{ id: string; key: string; name: string }>(
    `SELECT id, key, name FROM classification_dimensions ORDER BY key`,
  );
  return rows;
}

/**
 * Resolves a controlled classification value under a known dimension, creating
 * it only if it is genuinely new. Same race-free shape as `resolveBrand`, on
 * `classification_values_unique_in_dimension`.
 *
 * The **dimension** is never created here: an unknown dimension key is a
 * validation failure, because inventing a kind of grouping is a decision about
 * the merchandise model rather than a side effect of entering one product.
 * Values are the shop's own data, so `Sandals` typed for the first time is a new
 * value and not an error.
 */
export async function resolveClassificationValue(
  tx: DatabaseClient,
  params: {
    id: string;
    dimensionId: string;
    value: string;
    normalizedValue: string;
    now: Date;
  },
): Promise<string> {
  await tx.query(
    `INSERT INTO classification_values
       (id, dimension_id, value, normalized_value, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (dimension_id, normalized_value) DO NOTHING`,
    [params.id, params.dimensionId, params.value, params.normalizedValue, params.now],
  );

  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM classification_values WHERE dimension_id = $1 AND normalized_value = $2`,
    [params.dimensionId, params.normalizedValue],
  );
  const row = rows[0];
  // Unreachable, for the same reason as in `resolveBrand`.
  if (!row) throw new Error(`Classification value "${params.normalizedValue}" vanished`);
  return row.id;
}

/**
 * The controlled vocabulary of variant attribute names.
 *
 * The service checks against this before writing, so a request naming an
 * attribute nobody has defined is a field-level `VALIDATION_FAILED` rather than
 * a foreign-key error the caller cannot read. The database enforces the same
 * rule on every write regardless (`variant_attributes_name_defined_fk`, 0010),
 * so this read is the message and not the guarantee.
 */
export async function listAttributeDefinitions(
  db: Queryable,
): Promise<VariantAttributeDefinition[]> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM variant_attribute_definitions ORDER BY name`,
  );
  return rows;
}

export async function listBrands(db: Queryable): Promise<Brand[]> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM brands ORDER BY normalized_name`,
  );
  return rows;
}

/**
 * Every classification dimension with the values defined under it, in two
 * statements rather than one per dimension.
 */
export async function listClassificationDimensions(
  db: Queryable,
): Promise<ClassificationDimension[]> {
  const dimensions = await listDimensions(db);
  if (dimensions.length === 0) return [];

  const { rows } = await db.query<{ id: string; dimension_id: string; value: string }>(
    `SELECT id, dimension_id, value FROM classification_values
      ORDER BY dimension_id, normalized_value`,
  );

  const byDimension = new Map<string, { id: string; value: string }[]>();
  for (const row of rows) {
    const list = byDimension.get(row.dimension_id) ?? [];
    list.push({ id: row.id, value: row.value });
    byDimension.set(row.dimension_id, list);
  }

  return dimensions.map((dimension) => ({
    key: dimension.key,
    name: dimension.name,
    values: byDimension.get(dimension.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * `lifecycle_status` is written explicitly rather than left to the column's
 * default: new merchandise begins `ACTIVE` because that is what creating it
 * means, and stating it here keeps the fact in the code that decides it rather
 * than in a default PR 5 may drop.
 */
export async function insertProduct(
  tx: DatabaseClient,
  params: InsertProductParams,
): Promise<void> {
  await tx.query(
    `INSERT INTO products (id, name, description, brand_id, lifecycle_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6)`,
    [
      params.id,
      params.name,
      params.description,
      params.brandId,
      params.createdAt,
      params.updatedAt,
    ],
  );
}

/**
 * Inserts one variant. May throw a unique violation on the SKU or the
 * (product_id, variant_signature) constraint; the caller decides how to react.
 *
 * `variant_signature` is written but never read back onto the wire. It is the
 * database's handle on variant identity — what makes "White / Size 9" twice
 * under one product impossible — and clients were always told to treat it as
 * opaque, so it is no longer sent to them at all.
 */
export async function insertVariant(
  tx: DatabaseClient,
  params: InsertVariantParams,
): Promise<void> {
  await tx.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, lifecycle_status,
        selling_price_minor, selling_price_currency,
        reference_cost_minor, reference_cost_currency,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, $8, $9, $10)`,
    [
      params.id,
      params.productId,
      params.sku,
      params.variantSignature,
      params.sellingPrice?.amountMinor ?? null,
      params.sellingPrice?.currency ?? null,
      params.referenceCost?.amountMinor ?? null,
      params.referenceCost?.currency ?? null,
      params.createdAt,
      params.updatedAt,
    ],
  );
}

export async function insertVariantAttributes(
  tx: DatabaseClient,
  variantId: string,
  attributes: NormalizedAttribute[],
): Promise<void> {
  for (const attribute of attributes) {
    await tx.query(
      `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
       VALUES ($1, $2, $3)`,
      [variantId, attribute.name, attribute.value],
    );
  }
}

export async function insertVariantBarcodes(
  tx: DatabaseClient,
  variantId: string,
  barcodes: { id: string; barcode: string }[],
  now: Date,
): Promise<void> {
  for (const entry of barcodes) {
    await tx.query(
      `INSERT INTO variant_barcodes (id, variant_id, barcode, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [entry.id, variantId, entry.barcode, now],
    );
  }
}

export async function insertProductClassifications(
  tx: DatabaseClient,
  productId: string,
  assignments: ClassificationAssignment[],
  now: Date,
): Promise<void> {
  for (const assignment of assignments) {
    await tx.query(
      `INSERT INTO product_classifications (product_id, dimension_id, value_id, created_at)
       VALUES ($1, $2, $3, $4)`,
      [productId, assignment.dimensionId, assignment.valueId, now],
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The one product loader. `listCatalog` and `getProductById` are the same read
 * with a different filter, so they are the same code — a second mapper would be
 * a second definition of what a product is.
 *
 * **At most five statements, whatever the catalog holds**: products (with their
 * brand joined, not looked up), classifications, variants, attributes, and
 * barcodes. Fewer when the answer is smaller — no products means one statement
 * and no variants means three. The count is constant with respect to catalog
 * size: there is no query per product, per variant, or per classification, and
 * the tree is assembled in memory from complete lists.
 *
 * Ordering is fixed at every level: products by creation time then id, variants
 * likewise within a product, attributes and classifications and barcodes by
 * their own natural key. Two callers of this therefore see the same catalog in
 * the same order.
 */
async function loadProducts(db: Queryable, productId?: string): Promise<Product[]> {
  const { rows: productRows } = await db.query<ProductRow>(
    `SELECT p.id, p.name, p.description, p.brand_id, b.name AS brand_name,
            p.lifecycle_status, p.created_at, p.updated_at
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
      ${productId === undefined ? '' : 'WHERE p.id = $1'}
      ORDER BY p.created_at, p.id`,
    productId === undefined ? [] : [productId],
  );

  if (productRows.length === 0) return [];
  const productIds = productRows.map((row) => row.id);

  const { rows: classificationRows } = await db.query<ClassificationRow>(
    `SELECT pc.product_id, d.key AS dimension_key, d.name AS dimension_name, v.value
       FROM product_classifications pc
       JOIN classification_dimensions d ON d.id = pc.dimension_id
       JOIN classification_values v ON v.id = pc.value_id
      WHERE pc.product_id = ANY($1)
      ORDER BY pc.product_id, d.key`,
    [productIds],
  );

  const { rows: variantRows } = await db.query<VariantRow>(
    `SELECT id, product_id, sku, lifecycle_status,
            selling_price_minor, selling_price_currency,
            reference_cost_minor, reference_cost_currency,
            created_at, updated_at
       FROM product_variants
      WHERE product_id = ANY($1)
      ORDER BY product_id, created_at, id`,
    [productIds],
  );

  const variantIds = variantRows.map((row) => row.id);
  const attributeRows = variantIds.length === 0 ? [] : await loadAttributes(db, variantIds);
  const barcodeRows = variantIds.length === 0 ? [] : await loadBarcodes(db, variantIds);

  const attributesByVariant = groupAttributes(attributeRows);
  const barcodesByVariant = groupBarcodes(barcodeRows);
  const classificationsByProduct = groupClassifications(classificationRows);

  const variantsByProduct = new Map<string, ProductVariant[]>();
  for (const row of variantRows) {
    const list = variantsByProduct.get(row.product_id) ?? [];
    list.push(
      toVariant(row, attributesByVariant.get(row.id) ?? [], barcodesByVariant.get(row.id) ?? []),
    );
    variantsByProduct.set(row.product_id, list);
  }

  return productRows.map((row) =>
    toProduct(row, variantsByProduct.get(row.id) ?? [], classificationsByProduct.get(row.id) ?? []),
  );
}

async function loadAttributes(db: Queryable, variantIds: string[]): Promise<AttributeRow[]> {
  const { rows } = await db.query<AttributeRow>(
    `SELECT variant_id, attribute_name, attribute_value
       FROM variant_attributes
      WHERE variant_id = ANY($1)
      ORDER BY variant_id, attribute_name`,
    [variantIds],
  );
  return rows;
}

async function loadBarcodes(db: Queryable, variantIds: string[]): Promise<BarcodeRow[]> {
  const { rows } = await db.query<BarcodeRow>(
    `SELECT variant_id, barcode
       FROM variant_barcodes
      WHERE variant_id = ANY($1)
      ORDER BY variant_id, barcode`,
    [variantIds],
  );
  return rows;
}

/** Every product with its brand, classifications, variants, and their detail. */
export async function listCatalog(db: Queryable): Promise<Product[]> {
  return loadProducts(db);
}

/**
 * Reads a single product back in full. Used by the create endpoint to return
 * exactly what was persisted, through the same loader as the list endpoint — so
 * a created product and the same product listed a moment later cannot differ.
 */
export async function getProductById(db: Queryable, id: string): Promise<Product | null> {
  const products = await loadProducts(db, id);
  return products[0] ?? null;
}

/**
 * Reads the lifecycle of one variant and of its parent product, **locking both
 * rows for the rest of the transaction**.
 *
 * This is what another module calls before it moves stock. It is deliberately
 * not `getProductById` — a workflow deciding "may I post against this?" has no
 * use for the product's other variants, their SKUs, or anybody's attributes,
 * and loading them would make an inventory write pay for a catalog read it
 * never looks at. Two rows, four columns.
 *
 * **The lock is the point, and it is what makes archive safety real.** `FOR
 * SHARE` on the product and the variant blocks any concurrent lifecycle change
 * (which takes `FOR UPDATE` on the same rows) until the posting transaction
 * commits or rolls back. So the two commands cannot cross unnoticed:
 *
 *   * if the archive gets the lock first, this read waits, then sees `ARCHIVED`
 *     and the movement is refused;
 *   * if this posting transaction gets it first, the archive waits, and by the
 *     time it reads the balance the new stock is committed and visible — so the
 *     archive is refused instead.
 *
 * Several posting transactions still run in parallel: `FOR SHARE` is shared, so
 * two receipts against the same variant do not block each other here. They
 * serialize later, on the balance row, exactly as they always did.
 *
 * **Lock order: `products` before `product_variants`, always.** Two statements
 * rather than one join for exactly that reason — the row order a joined `FOR
 * SHARE` takes its locks in is the planner's business, and lifecycle changes
 * take the same two locks in this order deliberately. A path that took them the
 * other way round would be an ABBA deadlock waiting for the first busy
 * afternoon.
 *
 * The join is inner and cannot change *whether* a row comes back: `product_id`
 * is `NOT NULL` and references `products`, so every variant has exactly one
 * parent. `null` here means "no such variant", which callers answer with a
 * `404`, and an existing variant of withdrawn merchandise must stay
 * distinguishable from a uuid that was never issued.
 */
export async function lockVariantLifecycle(
  tx: DatabaseClient,
  variantId: string,
): Promise<VariantLifecycle | null> {
  const { rows: productRows } = await tx.query<{ id: string; lifecycle_status: string }>(
    `SELECT p.id, p.lifecycle_status
       FROM products p
       JOIN product_variants v ON v.product_id = p.id
      WHERE v.id = $1
        FOR SHARE OF p`,
    [variantId],
  );
  const product = productRows[0];
  if (!product) return null;

  const { rows: variantRows } = await tx.query<{ id: string; lifecycle_status: string }>(
    `SELECT id, lifecycle_status
       FROM product_variants
      WHERE id = $1
        FOR SHARE`,
    [variantId],
  );
  const variant = variantRows[0];
  // Unreachable: the product row above was found through this very variant, and
  // catalog rows carrying history are never deleted (INV-12).
  if (!variant) return null;

  return {
    id: variant.id,
    productId: product.id,
    variantStatus: toLifecycle(variant.lifecycle_status),
    productStatus: toLifecycle(product.lifecycle_status),
  };
}

/**
 * Every variant that is still part of day-to-day operations, with the product
 * name, SKU, and attributes needed to label it.
 *
 * This is how the inventory module gets the *left-hand side* of the current
 * stock picture. It cannot query `product_variants` itself (the catalog owns
 * those tables, and the lint rule enforces it), so the question crosses the
 * boundary as a call.
 *
 * **Operational means "not archived", at both levels** — which is the same rule
 * as "the effective lifecycle is not `ARCHIVED`", because the effective status
 * is the stricter of the two. `DISCONTINUED` merchandise is emphatically here:
 * the shop stopped reordering it, the units on the shelf are still real, still
 * sold, and still counted, and a current-stock screen that dropped them would
 * strand inventory the business owns. Archived merchandise is absent, and that
 * is only safe because archiving is refused while any stock remains.
 *
 * The permitted statuses are passed in from `domain/lifecycle.ts` rather than
 * written into the SQL, so the filter and the policy cannot disagree.
 *
 * Ledger history of everything, archived included, is untouched and stays
 * readable — this filters a present-tense operational view, it does not hide
 * the past.
 *
 * Two queries regardless of catalog size, never one per variant. Ordering is
 * fixed here rather than left to the caller: product name, then SKU, then id as
 * the final tie-breaker, so two products of the same name and two variants of
 * the same product still come back in one stable order.
 */
export async function listOperationalVariants(db: Queryable): Promise<OperationalVariantListing[]> {
  const { rows: variantRows } = await db.query<{
    id: string;
    product_id: string;
    sku: string;
    product_name: string;
  }>(
    `SELECT v.id, v.product_id, v.sku, p.name AS product_name
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.lifecycle_status = ANY($1) AND p.lifecycle_status = ANY($1)
      ORDER BY p.name, v.sku, v.id`,
    [OPERATIONAL_LIFECYCLE_STATUSES],
  );

  if (variantRows.length === 0) return [];

  const attributeRows = await loadAttributes(
    db,
    variantRows.map((row) => row.id),
  );
  const attributesByVariant = groupAttributes(attributeRows);

  return variantRows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    attributes: attributesByVariant.get(row.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Reads a product's lifecycle **and locks the row** for the rest of the
 * transaction.
 *
 * `FOR UPDATE`, because the caller is about to decide whether the merchandise
 * may change status and — for an archive — whether it holds stock. Both
 * decisions have to hold until the transaction commits, and the lock is what
 * makes a concurrent posting transaction wait rather than slip a movement in
 * between the check and the write.
 *
 * First in the lock order. Everything that touches both tables takes the
 * product row before the variant rows; see {@link lockVariantLifecycle}.
 */
export async function lockProductLifecycle(
  tx: DatabaseClient,
  productId: string,
): Promise<LifecycleStatus | null> {
  const { rows } = await tx.query<{ lifecycle_status: string }>(
    `SELECT lifecycle_status FROM products WHERE id = $1 FOR UPDATE`,
    [productId],
  );
  const row = rows[0];
  return row ? toLifecycle(row.lifecycle_status) : null;
}

/**
 * Reads one variant's own lifecycle **and locks the row**, without touching its
 * parent.
 *
 * The transition being decided is about this row's stored status, not the
 * effective one: withdrawing a colour of a product the shop still sells is the
 * ordinary case, and the parent's status is a ceiling on what may be *done*
 * with the variant rather than a constraint on what it may *become*.
 *
 * Taking no product lock is also what keeps this free of deadlock against a
 * product-level change: a transaction holding only a variant lock never goes on
 * to ask for a product lock, so there is no cycle to close.
 */
export async function lockVariantLifecycleForUpdate(
  tx: DatabaseClient,
  variantId: string,
): Promise<{ id: string; productId: string; status: LifecycleStatus } | null> {
  const { rows } = await tx.query<{
    id: string;
    product_id: string;
    lifecycle_status: string;
  }>(
    `SELECT id, product_id, lifecycle_status
       FROM product_variants
      WHERE id = $1
        FOR UPDATE`,
    [variantId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, productId: row.product_id, status: toLifecycle(row.lifecycle_status) }
    : null;
}

/**
 * Locks every variant of a product and returns their ids, in id order.
 *
 * Archiving a product is a statement about all of its variants — none of them
 * may hold stock — so all of them are locked, in one statement, before any
 * balance is read. `ORDER BY id` fixes the order two concurrent product
 * archives would take the locks in, so they queue instead of deadlocking.
 *
 * A product with no variants cannot exist (`createProduct` requires at least
 * one), but an empty result is returned as an empty list rather than treated as
 * an error: it is the caller's business what an unstocked product means.
 */
export async function lockVariantIdsForProduct(
  tx: DatabaseClient,
  productId: string,
): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id
       FROM product_variants
      WHERE product_id = $1
      ORDER BY id
        FOR UPDATE`,
    [productId],
  );
  return rows.map((row) => row.id);
}

/**
 * Writes a product's new lifecycle status and moves its `updated_at`.
 *
 * An `UPDATE` of two columns and nothing else. The caller has already locked the
 * row, decided that the transition is permitted, and — for an archive — proved
 * the merchandise holds no stock; this statement is the last thing in that
 * transaction rather than a place where any of it is re-decided.
 */
export async function updateProductLifecycle(
  tx: DatabaseClient,
  params: { id: string; status: LifecycleStatus; updatedAt: Date },
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE products
        SET lifecycle_status = $2,
            updated_at       = $3
      WHERE id = $1`,
    [params.id, params.status, params.updatedAt],
  );
  assertUpdatedExactlyOneRow(rowCount, `product ${params.id} while setting its lifecycle`);
}

/** The variant counterpart of {@link updateProductLifecycle}. */
export async function updateVariantLifecycle(
  tx: DatabaseClient,
  params: { id: string; status: LifecycleStatus; updatedAt: Date },
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE product_variants
        SET lifecycle_status = $2,
            updated_at       = $3
      WHERE id = $1`,
    [params.id, params.status, params.updatedAt],
  );
  assertUpdatedExactlyOneRow(rowCount, `variant ${params.id} while setting its lifecycle`);
}

/**
 * Guards an `UPDATE` that must touch exactly one row.
 *
 * Every caller locked the row earlier in the same transaction, so any other
 * count is a broken assumption rather than an ordinary failure: it throws, the
 * unit of work rolls back, and nothing half-written commits. Deliberately not an
 * upsert — a missing row here is a defect to surface, not a row to conjure.
 */
function assertUpdatedExactlyOneRow(rowCount: number | null, what: string): void {
  if (rowCount === 1) return;
  throw new AppError(
    'INTERNAL',
    `Expected to update exactly one row for ${what}, updated ${rowCount ?? 'unknown'}`,
  );
}

/**
 * Labels for a known set of variant ids, in bulk and regardless of lifecycle.
 * See {@link VariantLabel} for why the filter that `listOperationalVariants`
 * applies would be wrong here.
 *
 * Two statements for any number of ids — the variants joined to their products
 * and brands, then their attributes — so a page of history costs the same as
 * one movement. An id with no variant is simply absent from the result rather
 * than an error: the caller is resolving labels for permanent ledger ids and
 * decides for itself what a missing one means.
 */
export async function findVariantLabels(
  db: Queryable,
  variantIds: string[],
): Promise<VariantLabel[]> {
  if (variantIds.length === 0) return [];

  const { rows: variantRows } = await db.query<{
    id: string;
    product_id: string;
    sku: string;
    product_name: string;
    brand_name: string | null;
  }>(
    `SELECT v.id, v.product_id, v.sku, p.name AS product_name, b.name AS brand_name
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN brands b ON b.id = p.brand_id
      WHERE v.id = ANY($1)
      ORDER BY p.name, v.sku, v.id`,
    [variantIds],
  );

  if (variantRows.length === 0) return [];

  const attributesByVariant = groupAttributes(
    await loadAttributes(
      db,
      variantRows.map((row) => row.id),
    ),
  );

  return variantRows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    brandName: row.brand_name,
    sku: row.sku,
    attributes: attributesByVariant.get(row.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Indexes attribute rows by variant, preserving the order they arrived in —
 * which every query above fixes with `ORDER BY variant_id, attribute_name`, so
 * a variant's attributes are in the same order wherever they are returned.
 */
function groupAttributes(rows: AttributeRow[]): Map<string, VariantAttribute[]> {
  const byVariant = new Map<string, VariantAttribute[]>();
  for (const row of rows) {
    const list = byVariant.get(row.variant_id) ?? [];
    list.push({ name: row.attribute_name, value: row.attribute_value });
    byVariant.set(row.variant_id, list);
  }
  return byVariant;
}

function groupBarcodes(rows: BarcodeRow[]): Map<string, string[]> {
  const byVariant = new Map<string, string[]>();
  for (const row of rows) {
    const list = byVariant.get(row.variant_id) ?? [];
    list.push(row.barcode);
    byVariant.set(row.variant_id, list);
  }
  return byVariant;
}

function groupClassifications(rows: ClassificationRow[]): Map<string, ProductClassification[]> {
  const byProduct = new Map<string, ProductClassification[]>();
  for (const row of rows) {
    const list = byProduct.get(row.product_id) ?? [];
    list.push({
      dimension: row.dimension_key,
      dimensionName: row.dimension_name,
      value: row.value,
    });
    byProduct.set(row.product_id, list);
  }
  return byProduct;
}

/**
 * An amount and its currency are stored as two columns and constrained to be
 * both set or both null (INV-17), so exactly one of those two states can reach
 * here. `null` is "nobody has established this yet" and is returned as `null` —
 * never as a zero, which would say the item is free.
 */
function toMoney(amountMinor: number | null, currency: string | null): Money | null {
  if (amountMinor === null || currency === null) return null;
  return { amountMinor, currency };
}

/**
 * The lifecycle vocabulary is a database CHECK, mirrored by `LIFECYCLE_STATUSES`
 * in `@ekon/shared`; a test compares the two. The cast states that agreement
 * rather than re-deriving it, the same way movement types cross this boundary.
 */
function toLifecycle(status: string): Product['lifecycleStatus'] {
  return status as Product['lifecycleStatus'];
}

function toProduct(
  row: ProductRow,
  variants: ProductVariant[],
  classifications: ProductClassification[],
): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    brand:
      row.brand_id === null || row.brand_name === null
        ? null
        : { id: row.brand_id, name: row.brand_name },
    classifications,
    lifecycleStatus: toLifecycle(row.lifecycle_status),
    variants,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVariant(
  row: VariantRow,
  attributes: VariantAttribute[],
  barcodes: string[],
): ProductVariant {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    attributes,
    sellingPrice: toMoney(row.selling_price_minor, row.selling_price_currency),
    referenceCost: toMoney(row.reference_cost_minor, row.reference_cost_currency),
    barcodes,
    lifecycleStatus: toLifecycle(row.lifecycle_status),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
