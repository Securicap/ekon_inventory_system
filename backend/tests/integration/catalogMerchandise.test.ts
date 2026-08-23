import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  catalogMetadataResponseSchema,
  createProductResponseSchema,
  LIFECYCLE_STATUSES,
  listProductsResponseSchema,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { AppError } from '../../src/platform/http/errors.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createCatalogService, type CatalogService } from '../../src/modules/catalog/index.js';
import { productRequest } from '../helpers/catalogRequests.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * The merchandise model, working: brand, classification, controlled attribute
 * names, price, reference cost, and barcodes, through the service and through
 * the route.
 *
 * The vocabulary these exercise is not created by the tests. Classification
 * dimensions come from 0009 and attribute definitions from 0010, because both
 * are structure rather than data — which is exactly the rule being tested.
 */

/** The clock every integration suite pins, so the seeded session is still live. */
const NOW = new Date('2026-08-03T12:00:00.000Z');

let db: TestDatabase;
let app: FastifyInstance;
let owner: TestSession;
let catalog: CatalogService;

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool);
  app = await buildApp({
    config: { ...loadConfig(), LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock: fixedClock(NOW),
  });
  catalog = createCatalogService({ pool: db.pool, clock: fixedClock(NOW) });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

beforeEach(async () => {
  await db.pool.query('DELETE FROM variant_barcodes');
  await db.pool.query('DELETE FROM variant_attributes');
  await db.pool.query('DELETE FROM product_classifications');
  await db.pool.query('DELETE FROM product_variants');
  await db.pool.query('DELETE FROM products');
  await db.pool.query('DELETE FROM classification_values');
  await db.pool.query('DELETE FROM brands');
});

async function post(payload: unknown): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/catalog/products',
    headers: { 'content-type': 'application/json' },
    cookies: owner.cookies,
    payload: JSON.stringify(payload),
  });
  return { status: response.statusCode, body: response.json() };
}

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({ method: 'GET', url, cookies: owner.cookies });
  return { status: response.statusCode, body: response.json() };
}

/** The whole merchandise model in one request, as PR 7's form will send it. */
const BEL_AMI = {
  name: 'Bel Ami',
  brand: 'Steve Madden',
  classifications: { audience: 'Women', category: 'Footwear', type: 'Sandals' },
  variants: [
    {
      attributes: { color: 'Black', size: '8', width: 'M' },
      sellingPrice: { amountMinor: 249900, currency: 'HTG' },
      referenceCost: { amountMinor: 1800, currency: 'USD' },
      barcodes: ['0885140123456', 'DIST-99A'],
    },
  ],
};

describe('creating structured merchandise', () => {
  it('persists and returns the whole model', async () => {
    const { status, body } = await post(BEL_AMI);
    expect(status).toBe(201);

    const product = createProductResponseSchema.parse(body);
    expect(product.name).toBe('Bel Ami');
    expect(product.brand?.name).toBe('Steve Madden');
    expect(product.lifecycleStatus).toBe('ACTIVE');
    expect(product.classifications).toEqual([
      { dimension: 'audience', dimensionName: 'Audience', value: 'Women' },
      { dimension: 'category', dimensionName: 'Category', value: 'Footwear' },
      { dimension: 'type', dimensionName: 'Type', value: 'Sandals' },
    ]);

    const [variant] = product.variants;
    expect(variant?.sku).toMatch(/^EKN-[0-9A-Z]{8}$/);
    expect(variant?.attributes).toEqual([
      { name: 'color', value: 'Black' },
      { name: 'size', value: '8' },
      { name: 'width', value: 'M' },
    ]);
    expect(variant?.sellingPrice).toEqual({ amountMinor: 249900, currency: 'HTG' });
    expect(variant?.referenceCost).toEqual({ amountMinor: 1800, currency: 'USD' });
    expect(variant?.barcodes).toEqual(['0885140123456', 'DIST-99A']);
    expect(variant?.lifecycleStatus).toBe('ACTIVE');
  });

  it('reads back through the list exactly what creation returned', async () => {
    const created = createProductResponseSchema.parse((await post(BEL_AMI)).body);
    const listed = listProductsResponseSchema.parse((await get('/api/catalog/products')).body);
    expect(listed).toEqual([created]);
  });

  it('prices in one currency and costs in another, which is the ordinary case here', async () => {
    const product = createProductResponseSchema.parse((await post(BEL_AMI)).body);
    expect(product.variants[0]?.sellingPrice?.currency).toBe('HTG');
    expect(product.variants[0]?.referenceCost?.currency).toBe('USD');
  });

  it('stores an amount as whole minor units, not as a decimal', async () => {
    await post(BEL_AMI);
    const { rows } = await db.pool.query<{ selling_price_minor: number }>(
      `SELECT selling_price_minor FROM product_variants`,
    );
    expect(rows[0]?.selling_price_minor).toBe(249900);
  });
});

describe('brands', () => {
  it('creates a brand the first time it is named', async () => {
    await post({ ...BEL_AMI, name: 'One' });
    const { rows } = await db.pool.query<{ name: string; normalized_name: string }>(
      `SELECT name, normalized_name FROM brands`,
    );
    expect(rows).toEqual([{ name: 'Steve Madden', normalized_name: 'steve madden' }]);
  });

  it('reuses it however it is capitalized next time', async () => {
    const first = createProductResponseSchema.parse((await post({ ...BEL_AMI, name: 'One' })).body);
    const second = createProductResponseSchema.parse(
      (await post({ ...BEL_AMI, name: 'Two', brand: '  STEVE MADDEN  ' })).body,
    );

    expect(second.brand?.id).toBe(first.brand?.id);
    // The display case belongs to whoever created it: a later request is not
    // evidence that an earlier one was wrong.
    expect(second.brand?.name).toBe('Steve Madden');
    expect((await db.pool.query(`SELECT 1 FROM brands`)).rowCount).toBe(1);
  });

  it('ends up with one brand when two products name it at the same moment', async () => {
    // Both transactions try to insert; the second conflicts, reads, and finds
    // what the first committed. Check-then-insert would have made two.
    const [a, b] = await Promise.all([
      catalog.createProduct(productRequest({ name: 'Race A', brand: 'Nike' })),
      catalog.createProduct(productRequest({ name: 'Race B', brand: 'nike' })),
    ]);
    expect(a.brand?.id).toBe(b.brand?.id);
    expect((await db.pool.query(`SELECT 1 FROM brands`)).rowCount).toBe(1);
  });

  it('lets merchandise carry no brand', async () => {
    const product = createProductResponseSchema.parse(
      (await post({ name: 'Unbranded', variants: [{}] })).body,
    );
    expect(product.brand).toBeNull();
    expect((await db.pool.query(`SELECT 1 FROM brands`)).rowCount).toBe(0);
  });
});

describe('classification', () => {
  it('reuses a value however it is capitalized, under the same dimension', async () => {
    await post({ ...BEL_AMI, name: 'One' });
    await post({ ...BEL_AMI, name: 'Two', classifications: { category: 'FOOTWEAR' } });

    const { rows } = await db.pool.query<{ value: string }>(
      `SELECT v.value FROM classification_values v
         JOIN classification_dimensions d ON d.id = v.dimension_id
        WHERE d.key = 'category'`,
    );
    expect(rows.map((r) => r.value)).toEqual(['Footwear']);
  });

  it('refuses to invent a dimension from a product request', async () => {
    // Values are the shop's data; which kinds of grouping exist is a decision
    // about the merchandise model, and a typo must not make one.
    const { status, body } = await post({
      name: 'X',
      classifications: { colour_family: 'Warm' },
      variants: [{}],
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: [{ path: 'classifications.colour_family' }],
      },
    });
    expect(
      (await db.pool.query(`SELECT 1 FROM classification_dimensions WHERE key = 'colour_family'`))
        .rowCount,
    ).toBe(0);
  });

  it('lets a product be classified in only some dimensions', async () => {
    const product = createProductResponseSchema.parse(
      (await post({ name: 'Half', classifications: { category: 'Footwear' }, variants: [{}] }))
        .body,
    );
    expect(product.classifications).toEqual([
      { dimension: 'category', dimensionName: 'Category', value: 'Footwear' },
    ]);
  });

  it('lets a product carry no classification at all', async () => {
    const product = createProductResponseSchema.parse(
      (await post({ name: 'None', variants: [{}] })).body,
    );
    expect(product.classifications).toEqual([]);
  });

  it('ends up with one value when two products name it at the same moment', async () => {
    const [a, b] = await Promise.all([
      catalog.createProduct(
        productRequest({ name: 'Race A', classifications: { category: 'Handbags' } }),
      ),
      catalog.createProduct(
        productRequest({ name: 'Race B', classifications: { category: 'handbags' } }),
      ),
    ]);
    expect(a.classifications[0]?.value).toBe(b.classifications[0]?.value);
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM classification_values`,
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('controlled attribute names', () => {
  it('accepts every name in the vocabulary', async () => {
    const { status } = await post({
      name: 'Full',
      variants: [{ attributes: { color: 'Black', size: '8', width: 'M', material: 'Leather' } }],
    });
    expect(status).toBe(201);
  });

  it('refuses a name nobody has defined, and says which are defined', async () => {
    const { status, body } = await post({
      name: 'Typo',
      variants: [{ attributes: { colour: 'Black' } }],
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: [{ path: 'variants.0.attributes.colour' }],
      },
    });
    const detail = (body as { error: { details: { message: string }[] } }).error.details[0];
    expect(detail?.message).toContain('color');
    expect(detail?.message).toContain('material');
  });

  it('does not create the definition it just refused', async () => {
    await post({ name: 'Typo', variants: [{ attributes: { couleur: 'Noir' } }] });
    const { rows } = await db.pool.query<{ name: string }>(
      `SELECT name FROM variant_attribute_definitions ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(['color', 'material', 'size', 'width']);
  });

  it('refuses it after normalization, so capitalization is not a way around it', async () => {
    const { status } = await post({
      name: 'Typo',
      variants: [{ attributes: { '  COLOUR  ': 'Black' } }],
    });
    expect(status).toBe(400);
  });

  it('writes nothing at all when one variant names an undefined attribute', async () => {
    const { status } = await post({
      name: 'Partly Wrong',
      brand: 'Nike',
      variants: [{ attributes: { color: 'Black' } }, { attributes: { colour: 'White' } }],
    });
    expect(status).toBe(400);
    expect((await db.pool.query(`SELECT 1 FROM products`)).rowCount).toBe(0);
    // The brand is resolved inside the same transaction, so it is gone too.
    expect((await db.pool.query(`SELECT 1 FROM brands`)).rowCount).toBe(0);
  });
});

describe('barcodes', () => {
  it('stores several on one variant, and reads them back ordered', async () => {
    const product = createProductResponseSchema.parse(
      (await post({ name: 'Two Codes', variants: [{ barcodes: ['ZZZ-1', '0885140123456'] }] }))
        .body,
    );
    expect(product.variants[0]?.barcodes).toEqual(['0885140123456', 'ZZZ-1']);
  });

  it('allows the same code on two variants, because the world does', async () => {
    await post({ name: 'A', variants: [{ barcodes: ['0885140123456'] }] });
    const { status } = await post({ name: 'B', variants: [{ barcodes: ['0885140123456'] }] });
    expect(status).toBe(201);
  });

  it('refuses the same code twice on one variant, at the contract', async () => {
    const { status } = await post({
      name: 'Dup',
      variants: [{ barcodes: ['0885140123456', '0885140123456'] }],
    });
    expect(status).toBe(400);
  });
});

describe('transactionality', () => {
  it('leaves nothing behind when SKU allocation fails', async () => {
    // Force every generated SKU to collide with one that already exists.
    await post({ name: 'Existing', variants: [{}] });
    const { rows } = await db.pool.query<{ sku: string }>(`SELECT sku FROM product_variants`);
    const taken = rows[0]!.sku;

    const colliding = createCatalogService({
      pool: db.pool,
      clock: fixedClock(NOW),
      generateSku: () => taken,
    });

    await expect(
      colliding.createProduct(
        productRequest({
          name: 'Doomed',
          brand: 'Brand That Should Not Survive',
          classifications: { category: 'Category That Should Not Survive' },
          variants: [{ attributes: { color: 'Black' }, barcodes: ['DOOMED-1'] }],
        }),
      ),
    ).rejects.toBeInstanceOf(AppError);

    expect((await db.pool.query(`SELECT 1 FROM products WHERE name = 'Doomed'`)).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM brands`)).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM classification_values`)).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM variant_barcodes`)).rowCount).toBe(0);
  });
});

describe('merchandise migrated before any of this existed', () => {
  /**
   * A product as 0008 left it: no brand, nothing classified, nothing priced, no
   * barcode, and an attribute name from before the vocabulary. Written straight
   * to the tables, because no API could produce it any more — which is the
   * point. The read path must still answer for it.
   */
  async function seedLegacyProduct(): Promise<{ productId: string; variantId: string }> {
    const productId = newId();
    const variantId = newId();
    await db.pool.query(
      `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1, 'Diri', $2, $2)`,
      [productId, NOW],
    );
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, 'EKN-LEGACY01', '[["gwosè","5 mamit"]]', $3, $3)`,
      [variantId, productId, NOW],
    );
    // `NOT VALID` on the foreign key means existing rows are never checked, so a
    // legacy name can be written here the way it was written before 0010 —
    // through the constraint's own exemption, not around it.
    await db.pool.query(
      `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
       VALUES ($1, 'color', 'Blan')`,
      [variantId],
    );
    return { productId, variantId };
  }

  it('lists incomplete merchandise without failing', async () => {
    const { productId } = await seedLegacyProduct();
    const { status, body } = await get('/api/catalog/products');
    expect(status).toBe(200);

    const products = listProductsResponseSchema.parse(body);
    const legacy = products.find((p) => p.id === productId);
    expect(legacy).toBeDefined();
    expect(legacy?.brand).toBeNull();
    expect(legacy?.classifications).toEqual([]);
    expect(legacy?.lifecycleStatus).toBe('ACTIVE');
    expect(legacy?.variants[0]?.sellingPrice).toBeNull();
    expect(legacy?.variants[0]?.referenceCost).toBeNull();
    expect(legacy?.variants[0]?.barcodes).toEqual([]);
  });

  it('does not guess a brand out of the product name', async () => {
    await seedLegacyProduct();
    await get('/api/catalog/products');
    expect((await db.pool.query(`SELECT 1 FROM brands`)).rowCount).toBe(0);
  });

  it('keeps its SKU and its variant signature exactly as they were', async () => {
    const { variantId } = await seedLegacyProduct();
    await get('/api/catalog/products');
    const { rows } = await db.pool.query<{ sku: string; variant_signature: string }>(
      `SELECT sku, variant_signature FROM product_variants WHERE id = $1`,
      [variantId],
    );
    expect(rows[0]).toEqual({ sku: 'EKN-LEGACY01', variant_signature: '[["gwosè","5 mamit"]]' });
  });
});

describe('GET /api/catalog/metadata', () => {
  it('answers with the vocabulary the catalog already knows', async () => {
    await post(BEL_AMI);

    const { status, body } = await get('/api/catalog/metadata');
    expect(status).toBe(200);
    const metadata = catalogMetadataResponseSchema.parse(body);

    expect(metadata.brands.map((b) => b.name)).toEqual(['Steve Madden']);
    expect(metadata.variantAttributeDefinitions.map((d) => d.name)).toEqual([
      'color',
      'material',
      'size',
      'width',
    ]);
    expect(metadata.classificationDimensions.map((d) => d.key)).toEqual([
      'audience',
      'category',
      'type',
    ]);
    expect(
      metadata.classificationDimensions
        .find((d) => d.key === 'category')
        ?.values.map((v) => v.value),
    ).toEqual(['Footwear']);
  });

  it('answers on an empty catalog with the structure that is seeded', async () => {
    const metadata = catalogMetadataResponseSchema.parse((await get('/api/catalog/metadata')).body);
    expect(metadata.brands).toEqual([]);
    expect(metadata.classificationDimensions).toHaveLength(3);
    expect(metadata.classificationDimensions.every((d) => d.values.length === 0)).toBe(true);
    expect(metadata.variantAttributeDefinitions).toHaveLength(4);
  });

  it('is capability-protected like every other catalog read', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/catalog/metadata' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the lifecycle bridge', () => {
  it('does not let lifecycle decide what may be stocked', async () => {
    // PR 5 owns lifecycle control. Until then `is_active` is the authority, and
    // archiving a product must not change what receiving accepts — the
    // application has no way to set lifecycle, so a rule reading it would fire
    // on merchandise nobody had reviewed.
    const product = createProductResponseSchema.parse(
      (await post({ name: 'Archived', variants: [{}] })).body,
    );
    const variantId = product.variants[0]!.id;

    await db.pool.query(`UPDATE products SET lifecycle_status = 'ARCHIVED' WHERE id = $1`, [
      product.id,
    ]);
    expect(await catalog.findStockableVariant(variantId)).toMatchObject({ isActive: true });
    expect((await catalog.listStockableVariants()).some((v) => v.id === variantId)).toBe(true);

    await db.pool.query(`UPDATE products SET is_active = false WHERE id = $1`, [product.id]);
    expect(await catalog.findStockableVariant(variantId)).toMatchObject({ isActive: false });
    expect((await catalog.listStockableVariants()).some((v) => v.id === variantId)).toBe(false);
  });

  it('keeps the shared vocabulary equal to the database CHECK', async () => {
    const { rows } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'products_lifecycle_status_known'`,
    );
    for (const status of LIFECYCLE_STATUSES) expect(rows[0]?.def).toContain(`'${status}'`);
    // And nothing the database accepts is missing from the shared list.
    expect(rows[0]?.def.match(/'[A-Z_]+'/g)?.length).toBe(LIFECYCLE_STATUSES.length);
  });
});

describe('what the inventory module sees', () => {
  it('is unchanged by the merchandise model', async () => {
    const product = createProductResponseSchema.parse((await post(BEL_AMI)).body);
    const listing = await catalog.listStockableVariants();

    expect(listing).toEqual([
      {
        id: product.variants[0]!.id,
        productId: product.id,
        productName: 'Bel Ami',
        sku: product.variants[0]!.sku,
        attributes: [
          { name: 'color', value: 'Black' },
          { name: 'size', value: '8' },
          { name: 'width', value: 'M' },
        ],
      },
    ]);
    // No brand, no price, no cost, no classification: nothing renders them, and
    // widening this would couple inventory to the whole merchandise model.
    expect(Object.keys(listing[0]!).sort()).toEqual([
      'attributes',
      'id',
      'productId',
      'productName',
      'sku',
    ]);
  });
});
