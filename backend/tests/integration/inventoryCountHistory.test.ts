import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countPageSchema, type CountPage, type CountRecord } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import type { Clock } from '../../src/platform/clock/index.js';
import type { DatabasePool } from '../../src/platform/db/pool.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `GET /api/inventory/counts` — what has been counted, and what is still
 * unexplained.
 *
 * Count history is **not** reconstructible from movement history, which is the
 * reason this read exists at all: a matched count posts nothing, and an
 * unresolved discrepancy posts nothing either. The ledger answers *what changed
 * the stock*; this answers *what somebody physically saw*, and a shop needs
 * both to investigate anything.
 *
 * The other property under test is that evidence is not filtered by
 * present-tense operational status. A count of merchandise the shop has since
 * archived, on a shelf it has since closed, by somebody who has since left, is
 * exactly the record somebody goes looking for.
 */

const COUNTS = '/api/inventory/counts';
const RECORDED_AT = '2026-08-03T12:00:00.000Z';
const COUNTED_AT = '2026-08-03T10:15:00.000Z';

let db: TestDatabase;
let app: FastifyInstance;
let owner: TestSession;
let clock: Clock;
/** Moves with each recorded count so the feed has a deterministic order. */
let now = new Date(RECORDED_AT);

interface Shelf {
  variantId: string;
  locationId: string;
  sku: string;
  productName: string;
  locationName: string;
}

let skuCounter = 0;

async function newShelf(
  options: { productName?: string; locationName?: string; brand?: string } = {},
): Promise<Shelf> {
  skuCounter += 1;
  const sku = `EKN-H${skuCounter.toString().padStart(7, '0')}`;
  const productName = options.productName ?? 'Count history fixture';
  const locationName = options.locationName ?? 'Count history shelf';

  let brandId: string | null = null;
  if (options.brand) {
    brandId = newId();
    await db.pool.query(
      `INSERT INTO brands (id, name, normalized_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [brandId, options.brand, options.brand.toLowerCase(), RECORDED_AT],
    );
  }

  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, brand_id, lifecycle_status, created_at, updated_at)
     VALUES ($1, $2, $3, 'ACTIVE', $4, $4)`,
    [productId, productName, brandId, RECORDED_AT],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, lifecycle_status, created_at, updated_at)
     VALUES ($1, $2, $3, '[["size","38"]]', 'ACTIVE', $4, $4)`,
    [variantId, productId, sku, RECORDED_AT],
  );
  await db.pool.query(
    `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
     VALUES ($1, 'size', '38')`,
    [variantId],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, $2, false, true, $3, $3)`,
    [locationId, locationName, RECORDED_AT],
  );

  return { variantId, locationId, sku, productName, locationName };
}

async function receive(shelf: Shelf, quantity: number): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/receive',
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId: shelf.variantId,
      locationId: shelf.locationId,
      quantity,
      occurredAt: COUNTED_AT,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
}

/** Records one observation, advancing the clock so the feed order is total. */
async function recordCount(
  shelf: Shelf,
  countedQuantity: number,
  session: TestSession = owner,
): Promise<CountRecord> {
  now = new Date(now.getTime() + 1000);
  const response = await app.inject({
    method: 'POST',
    url: COUNTS,
    cookies: session.cookies,
    payload: {
      operationId: newId(),
      variantId: shelf.variantId,
      locationId: shelf.locationId,
      countedQuantity,
      countedAt: COUNTED_AT,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return response.json() as CountRecord;
}

async function page(query = ''): Promise<CountPage> {
  const response = await app.inject({
    method: 'GET',
    url: `${COUNTS}${query}`,
    cookies: owner.cookies,
  });
  expect(response.statusCode, response.payload).toBe(200);
  return countPageSchema.parse(response.json());
}

/** Counts the statements one request issues, so an N+1 cannot creep in. */
async function statementsDuring<T>(pool: DatabasePool, work: () => Promise<T>): Promise<number> {
  const client = await pool.connect();
  let issued = 0;
  try {
    const original = pool.query.bind(pool);
    const counting = ((...args: Parameters<typeof original>) => {
      issued += 1;
      return original(...args);
    }) as typeof pool.query;
    (pool as { query: typeof pool.query }).query = counting;
    await work();
    (pool as { query: typeof pool.query }).query = original;
  } finally {
    client.release();
  }
  return issued;
}

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool, { role: 'OWNER' });
  clock = { now: () => now };
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

describe('one count, fully labelled', () => {
  it('carries the merchandise, the shelf, the counter, and the three numbers', async () => {
    const shelf = await newShelf({
      productName: 'Bel Ami',
      locationName: 'Main Store',
      brand: 'Steve Madden',
    });
    await receive(shelf, 7);
    const count = await recordCount(shelf, 6);

    const { items } = await page(`?variantId=${shelf.variantId}`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: count.id,
      expectedQuantity: 7,
      countedQuantity: 6,
      variance: -1,
      status: 'OPEN',
      countedAt: COUNTED_AT,
      reconciliation: null,
      variant: {
        id: shelf.variantId,
        productName: 'Bel Ami',
        brandName: 'Steve Madden',
        sku: shelf.sku,
        attributes: [{ name: 'size', value: '38' }],
      },
      location: { id: shelf.locationId, name: 'Main Store' },
      counter: { id: owner.user.id, displayName: owner.user.displayName },
    });
  });

  it('shows the reconciliation once a discrepancy has been accepted', async () => {
    const shelf = await newShelf();
    await receive(shelf, 5);
    const count = await recordCount(shelf, 3);

    const reconciled = await app.inject({
      method: 'POST',
      url: `${COUNTS}/${count.id}/reconcile`,
      cookies: owner.cookies,
      payload: { operationId: newId(), reason: 'DAMAGED', note: 'Two crushed in the stockroom' },
    });
    expect(reconciled.statusCode).toBe(200);

    const { items } = await page(`?variantId=${shelf.variantId}`);
    expect(items[0]).toMatchObject({
      status: 'RECONCILED',
      variance: -2,
      reconciliation: {
        reason: 'DAMAGED',
        note: 'Two crushed in the stockroom',
        actor: { id: owner.user.id, displayName: owner.user.displayName },
      },
    });
    expect(items[0]?.reconciliation?.movementId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('filters', () => {
  it('narrows to unresolved discrepancies', async () => {
    // The question the workflow exists for, and the one the OR1 screen opens
    // with: what is still unexplained?
    const shelf = await newShelf();
    await receive(shelf, 10);
    const open = await recordCount(shelf, 8);
    const matched = await recordCount(shelf, 10);
    const toSettle = await recordCount(shelf, 9);

    await app.inject({
      method: 'POST',
      url: `${COUNTS}/${toSettle.id}/reconcile`,
      cookies: owner.cookies,
      payload: { operationId: newId(), reason: 'SHRINKAGE' },
    });

    const unresolved = await page(`?variantId=${shelf.variantId}&status=OPEN`);
    expect(unresolved.items.map((item) => item.id)).toEqual([open.id]);

    const matches = await page(`?variantId=${shelf.variantId}&status=MATCHED`);
    expect(matches.items.map((item) => item.id)).toEqual([matched.id]);

    const settled = await page(`?variantId=${shelf.variantId}&status=RECONCILED`);
    expect(settled.items.map((item) => item.id)).toEqual([toSettle.id]);
  });

  it('narrows by variant and by location', async () => {
    const first = await newShelf();
    const second = await newShelf();
    const one = await recordCount(first, 1);
    const two = await recordCount(second, 2);

    expect((await page(`?variantId=${first.variantId}`)).items.map((i) => i.id)).toEqual([one.id]);
    expect((await page(`?locationId=${second.locationId}`)).items.map((i) => i.id)).toEqual([
      two.id,
    ]);
  });

  it('refuses a mistyped filter rather than answering with everything', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${COUNTS}?varientId=${newId()}`,
      cookies: owner.cookies,
    });
    expect(response.statusCode).toBe(400);
  });

  it('narrows by recorded time, inclusively at both ends', async () => {
    const shelf = await newShelf();
    const at = new Date(now.getTime() + 1000).toISOString();
    const earlier = new Date(now.getTime() - 1000).toISOString();
    const counted = await recordCount(shelf, 4);
    expect(counted.recordedAt).toBe(at);

    // The bounds name `recordedAt` and include it, which is what the contract
    // says: a range that excluded its own endpoints would make a day's counts
    // depend on how somebody wrote midnight.
    expect((await page(`?variantId=${shelf.variantId}&recordedFrom=${at}`)).items).toHaveLength(1);
    expect((await page(`?variantId=${shelf.variantId}&recordedTo=${at}`)).items).toHaveLength(1);
    expect((await page(`?variantId=${shelf.variantId}&recordedTo=${earlier}`)).items).toHaveLength(
      0,
    );
  });
});

describe('ordering and pagination', () => {
  it('reads newest recorded first, and pages without repeating or skipping', async () => {
    const shelf = await newShelf();
    const recorded: string[] = [];
    for (let i = 0; i < 5; i += 1) recorded.push((await recordCount(shelf, i)).id);
    const newestFirst = [...recorded].reverse();

    const first = await page(`?variantId=${shelf.variantId}&limit=2`);
    expect(first.items.map((item) => item.id)).toEqual(newestFirst.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();

    const second = await page(
      `?variantId=${shelf.variantId}&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.items.map((item) => item.id)).toEqual(newestFirst.slice(2, 4));

    const third = await page(
      `?variantId=${shelf.variantId}&limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`,
    );
    expect(third.items.map((item) => item.id)).toEqual(newestFirst.slice(4));
    // Null on the last page, and only then.
    expect(third.nextCursor).toBeNull();
  });

  it('refuses a cursor it did not issue', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${COUNTS}?cursor=not-a-cursor`,
      cookies: owner.cookies,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('evidence is not filtered by what is operational today', () => {
  it('reads a count of merchandise that has since been archived', async () => {
    const shelf = await newShelf({ productName: 'Withdrawn Line' });
    const count = await recordCount(shelf, 0);
    await db.pool.query(`UPDATE product_variants SET lifecycle_status = 'ARCHIVED' WHERE id = $1`, [
      shelf.variantId,
    ]);

    const { items } = await page(`?variantId=${shelf.variantId}`);
    expect(items.map((item) => item.id)).toEqual([count.id]);
    // Fully labelled, not merely present.
    expect(items[0]?.variant.productName).toBe('Withdrawn Line');
  });

  it('reads a count taken on a shelf that has since been closed', async () => {
    const shelf = await newShelf({ locationName: 'Closed Kiosk' });
    const count = await recordCount(shelf, 2);
    await db.pool.query(`UPDATE inventory_locations SET is_active = false WHERE id = $1`, [
      shelf.locationId,
    ]);

    const { items } = await page(`?locationId=${shelf.locationId}`);
    expect(items.map((item) => item.id)).toEqual([count.id]);
    expect(items[0]?.location.name).toBe('Closed Kiosk');
  });

  it('still names somebody who has since been deactivated', async () => {
    // Deactivating an account stops somebody signing in. It does not unwrite
    // the count they took, and history that stopped naming them would be worse
    // than useless in an investigation.
    const leaver = await createTestSession(db.pool, {
      role: 'MANAGER',
      username: 'left.the.shop',
      displayName: 'Jean Baptiste',
    });
    const shelf = await newShelf();
    const count = await recordCount(shelf, 3, leaver);

    await db.pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [leaver.user.id]);

    const { items } = await page(`?variantId=${shelf.variantId}`);
    expect(items[0]).toMatchObject({
      id: count.id,
      counter: { id: leaver.user.id, displayName: 'Jean Baptiste' },
    });
  });

  it('shows the product name it has now, because labels are current', async () => {
    // The same rule movement history states. The count refers to an immutable
    // variant id and SKU; the name beside it is resolved from the table that
    // owns it today, and nothing here pretends to be a snapshot of what the
    // merchandise was called on the day it was counted.
    const shelf = await newShelf({ productName: 'Old Name' });
    const count = await recordCount(shelf, 1);

    await db.pool.query(`UPDATE products SET name = 'New Name' WHERE id = $1`, [
      (
        await db.pool.query<{ product_id: string }>(
          `SELECT product_id FROM product_variants WHERE id = $1`,
          [shelf.variantId],
        )
      ).rows[0]!.product_id,
    ]);

    const { items } = await page(`?variantId=${shelf.variantId}`);
    expect(items[0]).toMatchObject({ id: count.id, variant: { productName: 'New Name' } });
  });
});

describe('the query count is constant', () => {
  it('resolves a page of many counts without a query per row', async () => {
    // Four statements for the page: the count lines, the variant labels (two
    // inside the catalog), the location labels, and the display names. A fifth
    // shelf and a second counter change nothing.
    const first = await newShelf();
    const second = await newShelf();
    const other = await createTestSession(db.pool, {
      role: 'MANAGER',
      username: 'second.counter',
    });

    for (let i = 0; i < 6; i += 1) {
      await recordCount(i % 2 === 0 ? first : second, i, i % 3 === 0 ? other : owner);
    }

    const issued = await statementsDuring(db.pool, async () => {
      const { items } = await page('?limit=20');
      expect(items.length).toBeGreaterThanOrEqual(6);
    });

    // The session lookup the enforcement hook performs is in this number too,
    // which is why it is asserted as a small ceiling rather than an exact five.
    expect(issued).toBeLessThanOrEqual(8);
  });
});

describe('reading changes nothing', () => {
  it('creates no count, no movement, and no balance row', async () => {
    const shelf = await newShelf();
    await recordCount(shelf, 5);

    const before = await snapshot();
    await page();
    await page(`?status=OPEN`);
    expect(await snapshot()).toEqual(before);
  });

  async function snapshot(): Promise<Record<string, string>> {
    const { rows } = await db.pool.query<{ counts: string; movements: string; balances: string }>(
      `SELECT (SELECT count(*)::text FROM inventory_count_lines) AS counts,
              (SELECT count(*)::text FROM inventory_movements)   AS movements,
              (SELECT count(*)::text FROM inventory_balances)    AS balances`,
    );
    return rows[0]!;
  }
});
