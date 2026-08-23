import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/platform/clock/index.js';
import type { DatabasePool } from '../../src/platform/db/pool.js';
import { AppError } from '../../src/platform/http/errors.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { listCatalog } from '../../src/modules/catalog/infrastructure/catalogRepository.js';
import { createCatalogService } from '../../src/modules/catalog/index.js';
import { productRequest } from '../helpers/catalogRequests.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

const NOW = new Date('2026-08-03T12:00:00.000Z');

describe('catalog schema and constraints', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM variant_attributes');
    await db.pool.query('DELETE FROM product_variants');
    await db.pool.query('DELETE FROM products');
  });

  async function seedProduct(): Promise<string> {
    const id = newId();
    await db.pool.query(
      `INSERT INTO products (id, name, description, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
      [id, 'Seed', null, NOW],
    );
    return id;
  }

  async function seedVariant(productId: string, sku: string, signature = '[]'): Promise<string> {
    const id = newId();
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$5)`,
      [id, productId, sku, signature, NOW],
    );
    return id;
  }

  it('creates the three catalog tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('products','product_variants','variant_attributes')
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'product_variants',
      'products',
      'variant_attributes',
    ]);
  });

  it('declares the SKU and signature uniqueness constraints', async () => {
    const { rows } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('product_variants_sku_unique','product_variants_signature_unique')
        ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'product_variants_signature_unique',
      'product_variants_sku_unique',
    ]);
  });

  it('rejects a duplicate SKU', async () => {
    const p1 = await seedProduct();
    const p2 = await seedProduct();
    await seedVariant(p1, 'EKN-AAAAAAAA', '[]');
    await expect(seedVariant(p2, 'EKN-AAAAAAAA', '["x"]')).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects two variants with the same (product_id, variant_signature)', async () => {
    const p = await seedProduct();
    await seedVariant(p, 'EKN-BBBBBBBB', '[["color","White"]]');
    await expect(seedVariant(p, 'EKN-CCCCCCCC', '[["color","White"]]')).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('enforces the foreign key from variants to products', async () => {
    await expect(seedVariant(newId(), 'EKN-DDDDDDDD')).rejects.toMatchObject({ code: '23503' });
  });

  it('restricts deleting a product that still has variants', async () => {
    const p = await seedProduct();
    await seedVariant(p, 'EKN-EEEEEEEE');
    await expect(db.pool.query(`DELETE FROM products WHERE id = $1`, [p])).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('rejects any change to a SKU (database-level immutability)', async () => {
    const p = await seedProduct();
    const variantId = await seedVariant(p, 'EKN-FFFFFFFF');
    await expect(
      db.pool.query(`UPDATE product_variants SET sku = 'EKN-GGGGGGGG' WHERE id = $1`, [variantId]),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects a non-normalized (upper-cased) attribute name at the database', async () => {
    const p = await seedProduct();
    const variantId = await seedVariant(p, 'EKN-HHHHHHHH');
    await expect(
      db.pool.query(
        `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
         VALUES ($1, 'Color', 'White')`,
        [variantId],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });
});

describe('create-product transaction', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('rolls the whole product back when a variant cannot be inserted', async () => {
    // Seed a variant, then force the service to always generate that same SKU.
    // Every insert attempt collides, retries are exhausted, and the entire
    // transaction — including the product row — must roll back.
    const existingProductId = newId();
    await db.pool.query(
      `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1,'Existing',$2,$2)`,
      [existingProductId, NOW],
    );
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1,$2,'EKN-COLLIDES',$3,$4,$4)`,
      [newId(), existingProductId, '[]', NOW],
    );

    const before = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM products`,
    );

    const service = createCatalogService({
      pool: db.pool,
      clock: fixedClock(NOW),
      generateSku: () => 'EKN-COLLIDES',
    });

    let thrown: unknown;
    try {
      await service.createProduct(productRequest({ name: 'Doomed' }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('CONFLICT');
    expect((thrown as AppError).status).toBe(409);

    const after = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM products`,
    );
    // No new product persisted — only the seeded one remains.
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const doomed = await db.pool.query(`SELECT 1 FROM products WHERE name = 'Doomed'`);
    expect(doomed.rowCount).toBe(0);
  });
});

describe('list query shape', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('lists all products without an N+1 query pattern', async () => {
    const service = createCatalogService({ pool: db.pool, clock: fixedClock(NOW) });
    for (let i = 0; i < 5; i += 1) {
      await service.createProduct(
        productRequest({
          name: `Product ${i}`,
          variants: [{ attributes: {} }, { attributes: { color: 'X' } }],
        }),
      );
    }

    // Count queries issued while listing: it must be a small constant — five,
    // now that a product also carries a brand, classifications, and barcodes —
    // independent of how many products, variants, classifications, attributes,
    // or barcodes exist. The brand is joined rather than looked up, so it costs
    // no statement at all.
    let queryCount = 0;
    const counting = {
      query: (...args: unknown[]) => {
        queryCount += 1;
        return (db.pool.query as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as DatabasePool;

    const products = await listCatalog(counting);
    expect(products.length).toBe(5);
    expect(products.every((p) => p.variants.length === 2)).toBe(true);
    expect(queryCount).toBe(5);
  });
});
