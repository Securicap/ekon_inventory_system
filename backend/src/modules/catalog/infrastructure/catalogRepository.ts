import type { Product, ProductVariant, VariantAttribute } from '@ekon/shared';
import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';
import type { NormalizedAttribute } from '../domain/variantSignature.js';

/**
 * Catalog persistence. Hand-written SQL, typed row shapes kept internal to the
 * backend, and mapping to the shared wire types done in one place.
 *
 * Anything that reads may run against the pool or a transaction client; every
 * write takes a transaction client, because a product is only ever created as
 * one atomic unit with its variants and attributes.
 */

type Queryable = DatabasePool | DatabaseClient;

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  variant_signature: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface AttributeRow {
  variant_id: string;
  attribute_name: string;
  attribute_value: string;
}

export interface InsertProductParams {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertVariantParams {
  id: string;
  productId: string;
  sku: string;
  variantSignature: string;
  createdAt: Date;
  updatedAt: Date;
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

export async function insertProduct(
  tx: DatabaseClient,
  params: InsertProductParams,
): Promise<void> {
  await tx.query(
    `INSERT INTO products (id, name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.id, params.name, params.description, params.createdAt, params.updatedAt],
  );
}

/**
 * Inserts one variant. May throw a unique violation on the SKU or the
 * (product_id, variant_signature) constraint; the caller decides how to react.
 */
export async function insertVariant(
  tx: DatabaseClient,
  params: InsertVariantParams,
): Promise<void> {
  await tx.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.id,
      params.productId,
      params.sku,
      params.variantSignature,
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

/**
 * Lists every product with its variants and attributes in a fixed number of
 * queries — three, regardless of how many products exist — so the endpoint
 * never degrades into an N+1 pattern. Ordering is deterministic throughout.
 */
export async function listCatalog(db: Queryable): Promise<Product[]> {
  const { rows: productRows } = await db.query<ProductRow>(
    `SELECT id, name, description, is_active, created_at, updated_at
       FROM products
      ORDER BY created_at, id`,
  );

  if (productRows.length === 0) return [];

  const { rows: variantRows } = await db.query<VariantRow>(
    `SELECT id, product_id, sku, variant_signature, is_active, created_at, updated_at
       FROM product_variants
      ORDER BY product_id, created_at, id`,
  );

  const { rows: attributeRows } = await db.query<AttributeRow>(
    `SELECT variant_id, attribute_name, attribute_value
       FROM variant_attributes
      ORDER BY variant_id, attribute_name`,
  );

  const attributesByVariant = new Map<string, VariantAttribute[]>();
  for (const row of attributeRows) {
    const list = attributesByVariant.get(row.variant_id) ?? [];
    list.push({ name: row.attribute_name, value: row.attribute_value });
    attributesByVariant.set(row.variant_id, list);
  }

  const variantsByProduct = new Map<string, ProductVariant[]>();
  for (const row of variantRows) {
    const list = variantsByProduct.get(row.product_id) ?? [];
    list.push(toVariant(row, attributesByVariant.get(row.id) ?? []));
    variantsByProduct.set(row.product_id, list);
  }

  return productRows.map((row) => toProduct(row, variantsByProduct.get(row.id) ?? []));
}

/**
 * Reads a single product back in full. Used by the create endpoint to return
 * exactly what was persisted, through the same mapping as the list endpoint.
 */
export async function getProductById(db: Queryable, id: string): Promise<Product | null> {
  const { rows: productRows } = await db.query<ProductRow>(
    `SELECT id, name, description, is_active, created_at, updated_at
       FROM products
      WHERE id = $1`,
    [id],
  );
  const productRow = productRows[0];
  if (!productRow) return null;

  const { rows: variantRows } = await db.query<VariantRow>(
    `SELECT id, product_id, sku, variant_signature, is_active, created_at, updated_at
       FROM product_variants
      WHERE product_id = $1
      ORDER BY created_at, id`,
    [id],
  );

  const { rows: attributeRows } = await db.query<AttributeRow>(
    `SELECT variant_id, attribute_name, attribute_value
       FROM variant_attributes
      WHERE variant_id = ANY($1)
      ORDER BY variant_id, attribute_name`,
    [variantRows.map((row) => row.id)],
  );

  const attributesByVariant = new Map<string, VariantAttribute[]>();
  for (const row of attributeRows) {
    const list = attributesByVariant.get(row.variant_id) ?? [];
    list.push({ name: row.attribute_name, value: row.attribute_value });
    attributesByVariant.set(row.variant_id, list);
  }

  return toProduct(
    productRow,
    variantRows.map((row) => toVariant(row, attributesByVariant.get(row.id) ?? [])),
  );
}

function toProduct(row: ProductRow, variants: ProductVariant[]): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    variants,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVariant(row: VariantRow, attributes: VariantAttribute[]): ProductVariant {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    variantSignature: row.variant_signature,
    isActive: row.is_active,
    attributes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
