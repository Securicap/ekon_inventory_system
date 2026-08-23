import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  movementHistoryPageSchema,
  MOVEMENT_HISTORY_MAX_PAGE_SIZE,
  type InventoryMovementRecord,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import type { DatabasePool } from '../../src/platform/db/pool.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { listMovementHistory } from '../../src/modules/inventory/infrastructure/movementHistoryRepository.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `GET /api/inventory/movements`, end to end, against real PostgreSQL.
 *
 * The suite seeds the ledger directly rather than through receiving and
 * removal, for one reason: history has to be readable across situations the
 * write path cannot currently produce — a movement recorded by somebody who was
 * never an account, a shelf that has since been closed, merchandise that has
 * been retired. Those are exactly the records somebody goes looking for, and a
 * suite that could only build the happy present would never test them.
 *
 * The write path's own behaviour is asserted in `inventoryReceiving.test.ts`
 * and `inventoryRemoval.test.ts`, both untouched by this PR.
 */

/** Server time, from the injected clock. Inside the test session's lifetime. */
const NOW = new Date('2026-08-03T12:00:00.000Z');

let db: TestDatabase;
let app: FastifyInstance;
let owner: TestSession;
/** Somebody who may read inventory but not write it. */
let employee: TestSession;

interface Fixture {
  productId: string;
  variantId: string;
  locationId: string;
  brandId: string | null;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-H${skuCounter.toString().padStart(7, '0')}`;
}

/**
 * A product, a variant, and a location: one isolated chain to post against.
 * Every flag is settable, because history must survive all of them being false.
 */
async function newFixture(
  options: {
    brand?: string;
    productActive?: boolean;
    variantActive?: boolean;
    locationActive?: boolean;
    productName?: string;
  } = {},
): Promise<Fixture> {
  let brandId: string | null = null;
  if (options.brand !== undefined) {
    brandId = newId();
    await db.pool.query(
      `INSERT INTO brands (id, name, normalized_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [brandId, options.brand, options.brand.toLowerCase(), NOW],
    );
  }

  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, brand_id, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [
      productId,
      options.productName ?? 'History fixture',
      brandId,
      options.productActive ?? true,
      NOW,
    ],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, '[["color","black"]]', $4, $5, $5)`,
    [variantId, productId, nextSku(), options.variantActive ?? true, NOW],
  );
  await db.pool.query(
    `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
     VALUES ($1, 'color', 'Black')`,
    [variantId],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, $2, false, $3, $4, $4)`,
    [locationId, `Shelf ${skuCounter}`, options.locationActive ?? true, NOW],
  );

  return { productId, variantId, locationId, brandId };
}

/** The last movement posted on each chain, so the next one links to it. */
const chainHead = new Map<string, { id: string; quantity: number }>();

/**
 * Appends one movement directly, honouring every ledger constraint the posting
 * engine honours: the chain link, the arithmetic, and the reason requirement.
 * Nothing here updates a movement — the database would refuse it (INV-1).
 */
async function postMovement(params: {
  fixture: Fixture;
  movementType: 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT';
  quantityDelta: number;
  reasonCode?: string | null;
  note?: string | null;
  userId: string;
  occurredAt: Date;
  recordedAt: Date;
}): Promise<string> {
  const key = `${params.fixture.variantId} ${params.fixture.locationId}`;
  const head = chainHead.get(key);
  const before = head?.quantity ?? 0;
  const after = before + params.quantityDelta;

  const operationId = newId();
  const movementId = newId();

  await db.pool.query(
    `INSERT INTO operations (id, operation_type, request_hash, created_at)
     VALUES ($1, 'test.history', $2, $3)`,
    [operationId, movementId, params.recordedAt],
  );
  await db.pool.query(
    `INSERT INTO inventory_movements
       (id, variant_id, location_id, movement_type, quantity_delta, quantity_before,
        quantity_after, previous_movement_id, reverses_movement_id, operation_id,
        reason_code, note, user_id, occurred_at, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12, $13, $14)`,
    [
      movementId,
      params.fixture.variantId,
      params.fixture.locationId,
      params.movementType,
      params.quantityDelta,
      before,
      after,
      head?.id ?? null,
      operationId,
      params.reasonCode ?? null,
      params.note ?? null,
      params.userId,
      params.occurredAt,
      params.recordedAt,
    ],
  );

  await db.pool.query(
    `INSERT INTO inventory_balances (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (variant_id, location_id)
       DO UPDATE SET quantity_on_hand = $3, last_movement_id = $4, updated_at = $5`,
    [params.fixture.variantId, params.fixture.locationId, after, movementId, params.recordedAt],
  );

  chainHead.set(key, { id: movementId, quantity: after });
  return movementId;
}

async function history(
  query = '',
  session: TestSession = owner,
): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/inventory/movements${query}`,
    cookies: session.cookies,
  });
  return { status: response.statusCode, body: response.json() };
}

async function page(
  query = '',
): Promise<{ items: InventoryMovementRecord[]; nextCursor: string | null }> {
  const { status, body } = await history(query);
  expect(status).toBe(200);
  return movementHistoryPageSchema.parse(body);
}

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool);
  employee = await createTestSession(db.pool, { role: 'EMPLOYEE' });
  app = await buildApp({
    config: { ...loadConfig(), LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock: fixedClock(NOW),
  });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('an empty ledger', () => {
  it('answers with an empty page and no cursor', async () => {
    const result = await page();
    expect(result).toEqual({ items: [], nextCursor: null });
  });
});

describe('one movement, fully labelled', () => {
  let fixture: Fixture;
  let movementId: string;

  beforeAll(async () => {
    fixture = await newFixture({ brand: 'Steve Madden', productName: 'Bel Ami' });
    // Seven arrived, then one was sold: the shelf really held something before
    // the movement this suite is about, so the before/after are real.
    await postMovement({
      fixture,
      movementType: 'RECEIPT',
      quantityDelta: 7,
      userId: owner.user.id,
      occurredAt: new Date('2026-08-03T08:00:00.000Z'),
      recordedAt: new Date('2026-08-03T08:05:00.000Z'),
    });
    movementId = await postMovement({
      fixture,
      movementType: 'ISSUE',
      quantityDelta: -1,
      reasonCode: 'SOLD',
      note: 'Counter sale',
      userId: owner.user.id,
      occurredAt: new Date('2026-08-03T10:15:00.000Z'),
      recordedAt: new Date('2026-08-03T11:00:00.000Z'),
    });
  });

  it('returns every permanent ledger fact', async () => {
    const { items } = await page(`?variantId=${fixture.variantId}`);
    expect(items).toHaveLength(2);
    const record = items[0]!;

    expect(record.id).toBe(movementId);
    expect(record.movementType).toBe('ISSUE');
    expect(record.quantityDelta).toBe(-1);
    expect(record.quantityBefore).toBe(7);
    expect(record.quantityAfter).toBe(6);
    expect(record.reasonCode).toBe('SOLD');
    expect(record.note).toBe('Counter sale');
    expect(record.reversesMovementId).toBeNull();
    expect(record.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('carries no reason on the receipt, which says why in its type', async () => {
    const { items } = await page(`?variantId=${fixture.variantId}&movementType=RECEIPT`);
    expect(items).toHaveLength(1);
    expect(items[0]?.reasonCode).toBeNull();
    expect(items[0]?.note).toBeNull();
  });

  it('keeps business time and system time distinct', async () => {
    const { items } = await page(`?variantId=${fixture.variantId}`);
    const record = items[0]!;
    expect(record.occurredAt).toBe('2026-08-03T10:15:00.000Z');
    expect(record.recordedAt).toBe('2026-08-03T11:00:00.000Z');
    // The stock moved before anybody entered it, which is ordinary rather than
    // an error, and the feed keeps both facts.
    expect(Date.parse(record.occurredAt)).toBeLessThan(Date.parse(record.recordedAt));
  });

  it('labels the merchandise, the shelf, and the person', async () => {
    const { items } = await page(`?variantId=${fixture.variantId}`);
    const record = items[0]!;

    expect(record.variant.id).toBe(fixture.variantId);
    expect(record.variant.productId).toBe(fixture.productId);
    expect(record.variant.productName).toBe('Bel Ami');
    expect(record.variant.brandName).toBe('Steve Madden');
    expect(record.variant.sku).toMatch(/^EKN-[0-9A-Z]{8}$/);
    expect(record.variant.attributes).toEqual([{ name: 'color', value: 'Black' }]);

    expect(record.location.id).toBe(fixture.locationId);
    expect(record.location.name).toMatch(/^Shelf /);

    expect(record.actor.id).toBe(owner.user.id);
    expect(record.actor.displayName).toBe(owner.user.displayName);
  });

  it('does not put ledger internals on the wire', async () => {
    const { body } = await history(`?variantId=${fixture.variantId}`);
    const record = (body as { items: Record<string, unknown>[] }).items[0]!;
    for (const internal of ['previousMovementId', 'userId', 'variantId', 'locationId']) {
      expect(record).not.toHaveProperty(internal);
    }
  });
});

describe('labels are current, not historical snapshots', () => {
  it('shows the product name it has now, for a movement recorded before the rename', async () => {
    const fixture = await newFixture({ productName: 'Old Name' });
    await postMovement({
      fixture,
      movementType: 'RECEIPT',
      quantityDelta: 3,
      userId: owner.user.id,
      occurredAt: NOW,
      recordedAt: NOW,
    });

    const before = await page(`?variantId=${fixture.variantId}`);
    expect(before.items[0]?.variant.productName).toBe('Old Name');
    const sku = before.items[0]!.variant.sku;

    await db.pool.query(`UPDATE products SET name = 'New Name' WHERE id = $1`, [fixture.productId]);

    const after = await page(`?variantId=${fixture.variantId}`);
    // The label moved; the identity did not. This is what the contract means by
    // a current label rather than a snapshot.
    expect(after.items[0]?.variant.productName).toBe('New Name');
    expect(after.items[0]?.variant.sku).toBe(sku);
    expect(after.items[0]?.variant.id).toBe(fixture.variantId);
  });
});

describe('history that the current-stock view would hide', () => {
  it('reads a movement against retired merchandise', async () => {
    const fixture = await newFixture({ productActive: false, variantActive: false });
    const movementId = await postMovement({
      fixture,
      movementType: 'RECEIPT',
      quantityDelta: 2,
      userId: owner.user.id,
      occurredAt: NOW,
      recordedAt: NOW,
    });

    const { items } = await page(`?variantId=${fixture.variantId}`);
    expect(items.map((item) => item.id)).toEqual([movementId]);
    // Fully labelled, not merely present: `listStockableVariants` would have
    // dropped this variant, which is why history does not use it.
    expect(items[0]?.variant.productName).toBe('History fixture');
  });

  it('reads a movement against a closed shelf', async () => {
    const fixture = await newFixture({ locationActive: false });
    const movementId = await postMovement({
      fixture,
      movementType: 'RECEIPT',
      quantityDelta: 4,
      userId: owner.user.id,
      occurredAt: NOW,
      recordedAt: NOW,
    });

    const { items } = await page(`?locationId=${fixture.locationId}`);
    expect(items.map((item) => item.id)).toEqual([movementId]);
    expect(items[0]?.location.name).toMatch(/^Shelf /);
  });

  it('reads a movement recorded by somebody who was never an account', async () => {
    // `inventory_movements.user_id` carries no foreign key onto `users`
    // (INV-11), and early ledger rows hold actor uuids that were never people.
    const fixture = await newFixture();
    const ghost = newId();
    await postMovement({
      fixture,
      movementType: 'RECEIPT',
      quantityDelta: 1,
      userId: ghost,
      occurredAt: NOW,
      recordedAt: NOW,
    });

    const { items } = await page(`?variantId=${fixture.variantId}`);
    expect(items[0]?.actor).toEqual({ id: ghost, displayName: null });
  });

  it('still names a deactivated user', async () => {
    const gone = await createTestSession(db.pool, { username: 'gone.person' });
    const fixture = await newFixture();
    await postMovement({
      fixture,
      movementType: 'RECEIPT',
      quantityDelta: 1,
      userId: gone.user.id,
      occurredAt: NOW,
      recordedAt: NOW,
    });
    await db.pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [gone.user.id]);

    const { items } = await page(`?variantId=${fixture.variantId}`);
    // INV-16 deactivates rather than deletes precisely so this stays readable.
    expect(items[0]?.actor.displayName).toBe(gone.user.displayName);
  });
});

describe('ordering and pagination', () => {
  const seeded: string[] = [];
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await newFixture();
    // Twelve movements, recorded a minute apart. `occurredAt` deliberately runs
    // the other way, so a feed sorted by business time would come back
    // backwards — which is the mistake this ordering exists to avoid.
    for (let i = 0; i < 12; i += 1) {
      seeded.push(
        await postMovement({
          fixture,
          movementType: 'RECEIPT',
          quantityDelta: 1,
          userId: owner.user.id,
          occurredAt: new Date(Date.parse('2026-08-03T09:00:00.000Z') - i * 60_000),
          recordedAt: new Date(Date.parse('2026-08-03T11:00:00.000Z') + i * 60_000),
        }),
      );
    }
  });

  it('returns the newest recorded movement first', async () => {
    const { items } = await page(`?variantId=${fixture.variantId}`);
    expect(items.map((item) => item.id)).toEqual([...seeded].reverse());
  });

  it('is not ordered by business time', async () => {
    const { items } = await page(`?variantId=${fixture.variantId}`);
    const occurred = items.map((item) => Date.parse(item.occurredAt));
    // Ascending in business time while descending in recorded time: proof the
    // feed follows the ledger's own order and not when the stock moved.
    expect([...occurred].sort((a, b) => a - b)).toEqual(occurred);
  });

  it('walks every movement exactly once across pages', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let requests = 0;

    do {
      const query: string = `?variantId=${fixture.variantId}&limit=5${
        cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const result = await page(query);
      seen.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor;
      requests += 1;
      expect(requests).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toEqual([...seeded].reverse());
    expect(new Set(seen).size).toBe(seeded.length);
    // 12 movements at 5 a page: three requests, the last one short.
    expect(requests).toBe(3);
  });

  it('stops exactly on the last page rather than one page late', async () => {
    // Twelve movements at six a page: the second page is full, and it is still
    // the end. A `nextCursor` here would send a reader for an empty page.
    const first = await page(`?variantId=${fixture.variantId}&limit=6`);
    expect(first.items).toHaveLength(6);
    expect(first.nextCursor).not.toBeNull();

    const second = await page(
      `?variantId=${fixture.variantId}&limit=6&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.items).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
  });

  it('does not shift a row across a page boundary when the ledger grows', async () => {
    // Keyset pagination resumes at a position rather than counting past rows,
    // so a movement appended at the front while somebody is reading cannot make
    // an already-seen row appear again on the next page.
    const first = await page(`?variantId=${fixture.variantId}&limit=5`);
    await postMovement({
      fixture,
      movementType: 'RECEIPT',
      quantityDelta: 1,
      userId: owner.user.id,
      occurredAt: NOW,
      recordedAt: new Date('2026-08-03T13:00:00.000Z'),
    });

    const second = await page(
      `?variantId=${fixture.variantId}&limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const overlap = second.items.filter((item) =>
      first.items.some((earlier) => earlier.id === item.id),
    );
    expect(overlap).toEqual([]);
  });

  it('breaks a tie on identical recorded times deterministically', async () => {
    const tied = await newFixture();
    const at = new Date('2026-08-03T12:30:00.000Z');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(
        await postMovement({
          fixture: tied,
          movementType: 'RECEIPT',
          quantityDelta: 1,
          userId: owner.user.id,
          occurredAt: at,
          recordedAt: at,
        }),
      );
    }

    const { items } = await page(`?variantId=${tied.variantId}`);
    const order = items.map((item) => item.id);
    expect(order).toEqual([...ids].sort().reverse());

    // And the same order one page at a time, which is what makes the cursor
    // total rather than merely mostly-total.
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await page(
        `?variantId=${tied.variantId}&limit=1${
          cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
        }`,
      );
      walked.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor;
    } while (cursor !== null);
    expect(walked).toEqual(order);
  });
});

describe('filters', () => {
  let alpha: Fixture;
  let beta: Fixture;

  beforeAll(async () => {
    alpha = await newFixture();
    beta = await newFixture();

    await postMovement({
      fixture: alpha,
      movementType: 'RECEIPT',
      quantityDelta: 5,
      userId: owner.user.id,
      occurredAt: NOW,
      recordedAt: new Date('2026-08-04T09:00:00.000Z'),
    });
    await postMovement({
      fixture: alpha,
      movementType: 'ISSUE',
      quantityDelta: -2,
      reasonCode: 'DAMAGED',
      userId: owner.user.id,
      occurredAt: NOW,
      recordedAt: new Date('2026-08-04T10:00:00.000Z'),
    });
    await postMovement({
      fixture: beta,
      movementType: 'RECEIPT',
      quantityDelta: 9,
      userId: owner.user.id,
      occurredAt: NOW,
      recordedAt: new Date('2026-08-04T11:00:00.000Z'),
    });
  });

  it('narrows to one variant', async () => {
    const { items } = await page(`?variantId=${alpha.variantId}`);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.variant.id === alpha.variantId)).toBe(true);
  });

  it('narrows to one location', async () => {
    const { items } = await page(`?locationId=${beta.locationId}`);
    expect(items).toHaveLength(1);
    expect(items[0]?.location.id).toBe(beta.locationId);
  });

  it('narrows to one movement type', async () => {
    const { items } = await page(`?variantId=${alpha.variantId}&movementType=ISSUE`);
    expect(items).toHaveLength(1);
    expect(items[0]?.movementType).toBe('ISSUE');
    expect(items[0]?.reasonCode).toBe('DAMAGED');
  });

  it('combines filters, narrowing further', async () => {
    const { items } = await page(
      `?variantId=${alpha.variantId}&locationId=${alpha.locationId}&movementType=RECEIPT`,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.movementType).toBe('RECEIPT');
  });

  it('bounds by recorded time, inclusively at both ends', async () => {
    const { items } = await page(
      `?locationId=${alpha.locationId}` +
        `&recordedFrom=${encodeURIComponent('2026-08-04T10:00:00.000Z')}` +
        `&recordedTo=${encodeURIComponent('2026-08-04T10:00:00.000Z')}`,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.recordedAt).toBe('2026-08-04T10:00:00.000Z');
  });

  it('answers a filter that matches nothing with an empty page', async () => {
    const { items, nextCursor } = await page(`?variantId=${newId()}`);
    expect(items).toEqual([]);
    expect(nextCursor).toBeNull();
  });
});

describe('the query contract at the edge', () => {
  it('refuses a malformed uuid', async () => {
    const { status, body } = await history('?variantId=nope');
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('refuses a movement type outside the vocabulary', async () => {
    const { status } = await history('?movementType=SALE');
    expect(status).toBe(400);
  });

  it('refuses a page size above the maximum rather than trimming it', async () => {
    const { status } = await history(`?limit=${MOVEMENT_HISTORY_MAX_PAGE_SIZE + 1}`);
    expect(status).toBe(400);
    expect((await history(`?limit=${MOVEMENT_HISTORY_MAX_PAGE_SIZE}`)).status).toBe(200);
  });

  it('refuses a parameter it does not recognize', async () => {
    const { status } = await history('?varientId=00000000-0000-7000-8000-000000000001');
    expect(status).toBe(400);
  });

  it('refuses a cursor it did not issue, naming the field', async () => {
    const { status, body } = await history('?cursor=not-a-real-cursor');
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: [{ path: 'cursor' }] },
    });
  });

  it('refuses a range that runs backwards', async () => {
    const { status } = await history(
      `?recordedFrom=${encodeURIComponent('2026-08-31T00:00:00.000Z')}` +
        `&recordedTo=${encodeURIComponent('2026-08-01T00:00:00.000Z')}`,
    );
    expect(status).toBe(400);
  });
});

describe('authorization', () => {
  it('refuses an anonymous request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/inventory/movements' });
    expect(response.statusCode).toBe(401);
  });

  it('lets an employee read history, as they may read stock', async () => {
    const { status } = await history('', employee);
    expect(status).toBe(200);
  });

  it('refuses a session without inventory.read', async () => {
    // The capability is resolved from the user's current role on every request
    // (INV-15), so revoking the grant lands on the very next one.
    await db.pool.query(
      `DELETE FROM role_capabilities WHERE role = 'EMPLOYEE' AND capability = 'inventory.read'`,
    );
    try {
      const { status } = await history('', employee);
      expect(status).toBe(403);
    } finally {
      await db.pool.query(
        `INSERT INTO role_capabilities (role, capability) VALUES ('EMPLOYEE', 'inventory.read')`,
      );
    }
  });
});

describe('reading history changes nothing', () => {
  it('leaves every movement and every balance exactly as it found them', async () => {
    const snapshot = async () => {
      const movements = await db.pool.query<{ digest: string }>(
        `SELECT COALESCE(md5(string_agg(t, ',' ORDER BY t)), '') AS digest
           FROM (SELECT id || ':' || quantity_delta || ':' || quantity_before || ':'
                        || quantity_after || ':' || recorded_at AS t
                   FROM inventory_movements) s(t)`,
      );
      const balances = await db.pool.query<{ digest: string }>(
        `SELECT COALESCE(md5(string_agg(t, ',' ORDER BY t)), '') AS digest
           FROM (SELECT variant_id || ':' || location_id || ':' || quantity_on_hand || ':'
                        || COALESCE(last_movement_id::text, '-') || ':' || updated_at AS t
                   FROM inventory_balances) s(t)`,
      );
      const counts = await db.pool.query<{
        movements: string;
        balances: string;
        operations: string;
      }>(
        `SELECT (SELECT count(*)::text FROM inventory_movements) AS movements,
                (SELECT count(*)::text FROM inventory_balances)  AS balances,
                (SELECT count(*)::text FROM operations)          AS operations`,
      );
      return {
        movements: movements.rows[0]?.digest,
        balances: balances.rows[0]?.digest,
        counts: counts.rows[0],
      };
    };

    const before = await snapshot();
    expect(Number(before.counts?.movements)).toBeGreaterThan(0);

    // Every shape of read this endpoint offers, including one that pages.
    await page();
    await page('?limit=1');
    await page('?movementType=ISSUE');
    const first = await page('?limit=1');
    if (first.nextCursor !== null) {
      await page(`?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
    }

    expect(await snapshot()).toEqual(before);
  });

  it('creates no balance row for a shelf that has never held stock', async () => {
    const fixture = await newFixture();
    const before = await db.pool.query(`SELECT count(*)::int AS n FROM inventory_balances`);
    await page(`?variantId=${fixture.variantId}`);
    const after = await db.pool.query(`SELECT count(*)::int AS n FROM inventory_balances`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('the query count is constant', () => {
  it('costs the same statements for a page of one as for a full page', async () => {
    const counting = (): { pool: DatabasePool; count: () => number } => {
      let queries = 0;
      const pool = {
        query: (...args: unknown[]) => {
          queries += 1;
          return (db.pool.query as (...a: unknown[]) => unknown)(...args);
        },
      } as unknown as DatabasePool;
      return { pool, count: () => queries };
    };

    const one = counting();
    await listMovementHistory(one.pool, { limit: 2 });
    expect(one.count()).toBe(1);

    const many = counting();
    await listMovementHistory(many.pool, { limit: 51 });
    // One statement for the page, whatever the page holds. Labels are resolved
    // above this in three bulk calls, never one per movement.
    expect(many.count()).toBe(1);
  });

  it('resolves a page of many movements without a query per row', async () => {
    // Two variants, two locations, two actors across several movements: the
    // labels come back complete, from bulk lookups.
    const { items } = await page('?limit=100');
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((item) => item.variant.productName.length > 0)).toBe(true);
    expect(items.every((item) => item.location.name.length > 0)).toBe(true);
  });
});
