import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductResponseSchema, listProductsResponseSchema, SKU_PATTERN } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Catalog routes are capability-protected, so every request here arrives with a
 * session. These tests are about the catalog, not about authorization: one
 * owner, who holds every capability, keeps them focused on what they assert.
 * Who may do what is `tests/integration/authorization.test.ts`.
 */
let owner: TestSession;

interface Injected {
  status: number;
  body: unknown;
}

async function post(app: FastifyInstance, payload: unknown): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/catalog/products',
    headers: { 'content-type': 'application/json' },
    cookies: owner.cookies,
    payload: JSON.stringify(payload),
  });
  return { status: response.statusCode, body: response.json() };
}

describe('POST /api/catalog/products', () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    owner = await createTestSession(db.pool);
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent' },
      pool: db.pool,
      clock: fixedClock(new Date('2026-08-03T12:00:00.000Z')),
    });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('creates a product with a single default variant', async () => {
    const { status, body } = await post(app, {
      name: 'Bottled Water',
      variants: [{ attributes: {} }],
    });

    expect(status).toBe(201);
    const product = createProductResponseSchema.parse(body);
    expect(product.name).toBe('Bottled Water');
    expect(product.description).toBeNull();
    expect(product.isActive).toBe(true);
    expect(product.lifecycleStatus).toBe('ACTIVE');
    expect(product.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(product.createdAt).toBe('2026-08-03T12:00:00.000Z');
    expect(product.updatedAt).toBe('2026-08-03T12:00:00.000Z');

    // Merchandise nobody supplied comes back as an honest absence, never as a
    // placeholder and never as a zero price.
    expect(product.brand).toBeNull();
    expect(product.classifications).toEqual([]);

    expect(product.variants).toHaveLength(1);
    const [variant] = product.variants;
    expect(variant?.sku).toMatch(SKU_PATTERN);
    expect(variant?.attributes).toEqual([]);
    expect(variant?.sellingPrice).toBeNull();
    expect(variant?.referenceCost).toBeNull();
    expect(variant?.barcodes).toEqual([]);
    expect(variant?.lifecycleStatus).toBe('ACTIVE');
    expect(variant?.isActive).toBe(true);
    expect(variant?.productId).toBe(product.id);
  });

  it('does not put the variant signature on the wire', async () => {
    // It is the database's handle on variant identity and clients were always
    // told to treat it as opaque, so it is no longer sent at all. The column
    // still exists and still makes a duplicate variant impossible.
    const { body } = await post(app, { name: 'Opaque', variants: [{ attributes: {} }] });
    const variant = (body as { variants: Record<string, unknown>[] }).variants[0];
    expect(variant).not.toHaveProperty('variantSignature');
  });

  it('creates a product with multiple attributed variants and a unique SKU each', async () => {
    const { status, body } = await post(app, {
      name: 'Running Shoe',
      description: 'A shoe',
      variants: [
        { attributes: { color: 'White', size: '9' } },
        { attributes: { color: 'Black', size: '9' } },
      ],
    });

    expect(status).toBe(201);
    const product = createProductResponseSchema.parse(body);
    expect(product.description).toBe('A shoe');
    expect(product.variants).toHaveLength(2);

    const skus = product.variants.map((v) => v.sku);
    for (const sku of skus) expect(sku).toMatch(SKU_PATTERN);
    expect(new Set(skus).size).toBe(2);

    // Attributes come back ordered by normalized name.
    expect(product.variants[0]?.attributes).toEqual([
      { name: 'color', value: 'White' },
      { name: 'size', value: '9' },
    ]);
    expect(product.variants[1]?.attributes).toEqual([
      { name: 'color', value: 'Black' },
      { name: 'size', value: '9' },
    ]);
  });

  it('trims and normalizes accepted input', async () => {
    const { status, body } = await post(app, {
      name: '  Trimmed Name  ',
      description: '   ',
      variants: [{ attributes: { '  Color  ': '  White  ' } }],
    });

    expect(status).toBe(201);
    const product = createProductResponseSchema.parse(body);
    expect(product.name).toBe('Trimmed Name');
    expect(product.description).toBeNull(); // whitespace-only becomes null
    expect(product.variants[0]?.attributes).toEqual([{ name: 'color', value: 'White' }]);
  });

  it('reads attributes back in one order whatever order they were sent in', async () => {
    // Input order never matters: it is normalized away on arrival, which is what
    // makes two variants written with the same attributes the same variant.
    const first = await post(app, {
      name: 'Order A',
      variants: [{ attributes: { color: 'Red', size: '42' } }],
    });
    const second = await post(app, {
      name: 'Order B',
      variants: [{ attributes: { size: '42', color: 'Red' } }],
    });

    const a = createProductResponseSchema.parse(first.body);
    const b = createProductResponseSchema.parse(second.body);
    expect(a.variants[0]?.attributes).toEqual([
      { name: 'color', value: 'Red' },
      { name: 'size', value: '42' },
    ]);
    expect(b.variants[0]?.attributes).toEqual(a.variants[0]?.attributes);
  });

  it('rejects an empty product name with a structured validation error', async () => {
    const { status, body } = await post(app, { name: '   ', variants: [{ attributes: {} }] });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects a request with zero variants', async () => {
    const { status, body } = await post(app, { name: 'No Variants', variants: [] });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects a blank attribute name or value', async () => {
    const blankName = await post(app, {
      name: 'Blank Attr Name',
      variants: [{ attributes: { '   ': 'White' } }],
    });
    expect(blankName.status).toBe(400);
    expect(blankName.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    const blankValue = await post(app, {
      name: 'Blank Attr Value',
      variants: [{ attributes: { color: '   ' } }],
    });
    expect(blankValue.status).toBe(400);
    expect(blankValue.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects duplicate normalized variants in one request', async () => {
    // Same attribute set after name normalization (case/whitespace), same value:
    // these are the same variant and must be rejected.
    const { status, body } = await post(app, {
      name: 'Dup Variants',
      variants: [{ attributes: { color: 'White' } }, { attributes: { ' Color ': 'White' } }],
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects variants that differ only by attribute-value capitalization', async () => {
    // "White" and "white" are the same variant under the case-insensitive rule.
    const { status, body } = await post(app, {
      name: 'Running Shoe',
      variants: [
        { attributes: { color: 'White', size: '9' } },
        { attributes: { color: 'white', size: '9' } },
      ],
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects variants that differ only by whitespace and capitalization', async () => {
    const { status, body } = await post(app, {
      name: 'Whitespace Case',
      variants: [{ attributes: { color: 'White' } }, { attributes: { color: ' white ' } }],
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('accepts variants whose values genuinely differ', async () => {
    const { status, body } = await post(app, {
      name: 'Distinct Values',
      variants: [{ attributes: { color: 'White' } }, { attributes: { color: 'Black' } }],
    });
    expect(status).toBe(201);
    const product = createProductResponseSchema.parse(body);
    expect(product.variants).toHaveLength(2);
    // Display case preserved for both.
    expect(product.variants.map((v) => v.attributes[0]?.value).sort()).toEqual(['Black', 'White']);
  });

  it('does not allow the client to provide a SKU', async () => {
    const { status, body } = await post(app, {
      name: 'Client SKU',
      variants: [{ attributes: {}, sku: 'EKN-HACKHACK' }],
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('GET /api/catalog/products', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  const clock = fixedClock(new Date('2026-08-03T12:00:00.000Z'));

  beforeAll(async () => {
    db = await createTestDatabase();
    owner = await createTestSession(db.pool);
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent' },
      pool: db.pool,
      clock,
    });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('returns an empty array when no products exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/products',
      cookies: owner.cookies,
    });
    expect(response.statusCode).toBe(200);
    expect(listProductsResponseSchema.parse(response.json())).toEqual([]);
  });

  it('returns products with variants and attributes in deterministic order', async () => {
    // Distinct creation times so ordering by created_at is meaningful.
    await post(app, { name: 'First', variants: [{ attributes: { size: '2', color: 'Red' } }] });
    clock.advance(1000);
    await post(app, {
      name: 'Second',
      variants: [{ attributes: {} }, { attributes: { color: 'Blue' } }],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/products',
      cookies: owner.cookies,
    });
    expect(response.statusCode).toBe(200);
    const products = listProductsResponseSchema.parse(response.json());

    expect(products.map((p) => p.name)).toEqual(['First', 'Second']);
    // Active and inactive status is reported even though deactivation is not built.
    expect(products.every((p) => p.isActive === true)).toBe(true);

    // Attributes ordered by normalized name.
    expect(products[0]?.variants[0]?.attributes).toEqual([
      { name: 'color', value: 'Red' },
      { name: 'size', value: '2' },
    ]);
    // Variants ordered by creation, default (empty) variant created first.
    expect(products[1]?.variants).toHaveLength(2);
    expect(products[1]?.variants[0]?.attributes).toEqual([]);
  });
});
