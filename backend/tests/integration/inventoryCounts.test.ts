import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countPageSchema,
  countRecordSchema,
  movementHistoryPageSchema,
  type CountRecord,
  type ErrorBody,
  type LifecycleStatus,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import {
  COUNT_RECONCILE_OPERATION_TYPE,
  COUNT_RECORD_OPERATION_TYPE,
  COUNT_RESULT_RESOURCE_TYPE,
} from '../../src/modules/inventory/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Physical counts, end to end, against real PostgreSQL.
 *
 * **A count observes. Investigation explains. Reconciliation changes stock.**
 * Almost every assertion here is about the first sentence: recording that six
 * were seen where seven were expected must leave the ledger and the balance
 * exactly as they were. A `201` proves the route answered; only the unchanged
 * balance and the empty movement list prove that the observation stayed an
 * observation.
 *
 * The second thing this suite exists for is the snapshot. `expected_quantity`
 * is what Ekon held at the moment the count was entered, and it must survive
 * every receipt, sale, adjustment and reversal posted afterwards — because it
 * is the record of what the counter actually saw, and a read that recomputed it
 * against today's balance would rewrite that record every time the shop traded.
 */

/** Server time, from the injected clock. Inside the test session's lifetime. */
const RECORDED_AT = '2026-08-03T12:00:00.000Z';
/** Business time: the shelf was walked before somebody reached a computer. */
const COUNTED_AT = '2026-08-03T10:15:00.000Z';

const COUNTS = '/api/inventory/counts';

/** PostgreSQL's `restrict_violation`, which the immutability trigger raises. */
const RESTRICT_VIOLATION = '23001';

let db: TestDatabase;
let app: FastifyInstance;
/** Holds every capability, including `inventory.count`. */
let owner: TestSession;
/** Holds `inventory.count` under the default seed. */
let manager: TestSession;
/** Holds `inventory.read` but deliberately not `inventory.count`. */
let employee: TestSession;

interface Shelf {
  productId: string;
  variantId: string;
  locationId: string;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-C${skuCounter.toString().padStart(7, '0')}`;
}

async function newShelf(
  options: { variantLifecycle?: LifecycleStatus; locationActive?: boolean } = {},
): Promise<Shelf> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, lifecycle_status, created_at, updated_at)
     VALUES ($1, 'Count fixture', 'ACTIVE', $2, $2)`,
    [productId, RECORDED_AT],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, lifecycle_status, created_at, updated_at)
     VALUES ($1, $2, $3, '[]', $4, $5, $5)`,
    [variantId, productId, nextSku(), options.variantLifecycle ?? 'ACTIVE', RECORDED_AT],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, 'Count fixture shelf', false, $2, $3, $3)`,
    [locationId, options.locationActive ?? true, RECORDED_AT],
  );

  return { productId, variantId, locationId };
}

interface Injected {
  status: number;
  body: unknown;
}

function errorCode(body: unknown): string {
  return (body as ErrorBody).error.code;
}

function countBody(shelf: Shelf, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: newId(),
    variantId: shelf.variantId,
    locationId: shelf.locationId,
    countedQuantity: 6,
    countedAt: COUNTED_AT,
    ...overrides,
  };
}

async function record(payload: unknown, session: TestSession = owner): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: COUNTS,
    cookies: session.cookies,
    payload: payload as Record<string, unknown>,
  });
  return { status: response.statusCode, body: response.json() };
}

async function recordOk(payload: unknown, session: TestSession = owner): Promise<CountRecord> {
  const { status, body } = await record(payload, session);
  expect(status, JSON.stringify(body)).toBe(201);
  return countRecordSchema.parse(body);
}

async function reconcile(
  countId: string,
  payload: Record<string, unknown>,
  session: TestSession = owner,
): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: `${COUNTS}/${countId}/reconcile`,
    cookies: session.cookies,
    payload,
  });
  return { status: response.statusCode, body: response.json() };
}

async function reconcileOk(
  countId: string,
  payload: Record<string, unknown>,
  session: TestSession = owner,
): Promise<CountRecord> {
  const { status, body } = await reconcile(countId, payload, session);
  expect(status, JSON.stringify(body)).toBe(200);
  return countRecordSchema.parse(body);
}

function reconcileBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { operationId: newId(), reason: 'SHRINKAGE', ...overrides };
}

/** Books stock in through the ordinary workflow. */
async function receive(shelf: Shelf, quantity: number): Promise<string> {
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
  return (response.json() as { movementId: string }).movementId;
}

/** Takes stock off the shelf through the ordinary workflow. */
async function issue(shelf: Shelf, quantity: number): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/remove',
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId: shelf.variantId,
      locationId: shelf.locationId,
      quantity,
      reason: 'SOLD',
      occurredAt: COUNTED_AT,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return (response.json() as { movementId: string }).movementId;
}

async function onHand(shelf: Shelf): Promise<number | undefined> {
  const { rows } = await db.pool.query<{ quantity_on_hand: number }>(
    `SELECT quantity_on_hand FROM inventory_balances WHERE variant_id = $1 AND location_id = $2`,
    [shelf.variantId, shelf.locationId],
  );
  return rows[0]?.quantity_on_hand;
}

interface MovementRow {
  id: string;
  movement_type: string;
  quantity_delta: number;
  quantity_before: number;
  quantity_after: number;
  reason_code: string | null;
  note: string | null;
  user_id: string;
  occurred_at: Date;
  recorded_at: Date;
}

async function movements(shelf: Shelf): Promise<MovementRow[]> {
  const { rows } = await db.pool.query<MovementRow>(
    `SELECT id, movement_type, quantity_delta, quantity_before, quantity_after,
            reason_code, note, user_id, occurred_at, recorded_at
       FROM inventory_movements
      WHERE variant_id = $1 AND location_id = $2
      ORDER BY recorded_at, id`,
    [shelf.variantId, shelf.locationId],
  );
  return rows;
}

async function countRow(id: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT * FROM inventory_count_lines WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function operations(operationId: string): Promise<
  {
    operation_type: string;
    result_resource_type: string | null;
    result_resource_id: string | null;
  }[]
> {
  const { rows } = await db.pool.query<{
    operation_type: string;
    result_resource_type: string | null;
    result_resource_id: string | null;
  }>(
    `SELECT operation_type, result_resource_type, result_resource_id
       FROM operations WHERE id = $1`,
    [operationId],
  );
  return rows;
}

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool, { role: 'OWNER' });
  manager = await createTestSession(db.pool, { role: 'MANAGER' });
  employee = await createTestSession(db.pool, { role: 'EMPLOYEE' });
  app = await buildApp({
    config: { ...loadConfig(), LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock: fixedClock(new Date(RECORDED_AT)),
  });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('recording an observation', () => {
  it('snapshots what Ekon expected and reports the variance', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);

    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));

    expect(count.expectedQuantity).toBe(7);
    expect(count.countedQuantity).toBe(6);
    expect(count.variance).toBe(-1);
    expect(count.status).toBe('OPEN');
    expect(count.reconciliation).toBeNull();
    // From the session, never from the body.
    expect(count.counter.id).toBe(owner.user.id);
    expect(count.countedAt).toBe(COUNTED_AT);
    expect(count.recordedAt).toBe(RECORDED_AT);
    expect(count.location.id).toBe(shelf.locationId);
    expect(count.variant.id).toBe(shelf.variantId);
  });

  it('reports a positive variance the same way', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);

    const count = await recordOk(countBody(shelf, { countedQuantity: 9 }));
    expect(count.variance).toBe(2);
    expect(count.status).toBe('OPEN');
  });

  it('changes no stock at all', async () => {
    // The rule the whole workflow rests on. Counting six where seven were
    // expected must leave the shelf reading seven: the unmatched unit is
    // evidence, and overwriting it destroys the only signal the shop had.
    const shelf = await newShelf();
    await receive(shelf, 7);
    const before = await movements(shelf);

    await recordOk(countBody(shelf, { countedQuantity: 6 }));

    expect(await onHand(shelf)).toBe(7);
    expect(await movements(shelf)).toEqual(before);
  });

  it('expects zero on a shelf that has never held stock, and creates no balance row', async () => {
    const shelf = await newShelf();

    const count = await recordOk(countBody(shelf, { countedQuantity: 3 }));

    expect(count.expectedQuantity).toBe(0);
    expect(count.variance).toBe(3);
    // Only a reconciliation that actually moves stock brings a row into being.
    expect(await onHand(shelf)).toBeUndefined();
    expect(await movements(shelf)).toHaveLength(0);
  });

  it('records a count of zero on an empty shelf as a match', async () => {
    const shelf = await newShelf();
    const count = await recordOk(countBody(shelf, { countedQuantity: 0 }));

    expect(count.expectedQuantity).toBe(0);
    expect(count.variance).toBe(0);
    expect(count.status).toBe('MATCHED');
  });

  it('claims its operation under its own type, pointing at the count', async () => {
    const shelf = await newShelf();
    const request = countBody(shelf);
    const count = await recordOk(request);

    expect(await operations(request.operationId as string)).toEqual([
      {
        operation_type: COUNT_RECORD_OPERATION_TYPE,
        result_resource_type: COUNT_RESULT_RESOURCE_TYPE,
        result_resource_id: count.id,
      },
    ]);
  });
});

describe('a zero-variance count', () => {
  it('is persisted, settled, and posts nothing', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const before = await movements(shelf);

    const count = await recordOk(countBody(shelf, { countedQuantity: 7 }));

    expect(count.variance).toBe(0);
    expect(count.status).toBe('MATCHED');
    expect(count.reconciliation).toBeNull();

    // No `COUNT_RECONCILIATION` of zero — the ledger forbids a zero delta, and
    // rightly: a movement that changes nothing is not a movement.
    expect(await movements(shelf)).toEqual(before);
    expect(await onHand(shelf)).toBe(7);

    // And it stays visible as evidence that somebody checked and it was right.
    const listed = await app.inject({
      method: 'GET',
      url: `${COUNTS}?variantId=${shelf.variantId}`,
      cookies: owner.cookies,
    });
    const page = countPageSchema.parse(listed.json());
    expect(page.items.map((item) => item.id)).toEqual([count.id]);
  });

  it('cannot be reconciled, because there is nothing to accept', async () => {
    const shelf = await newShelf();
    await receive(shelf, 4);
    const count = await recordOk(countBody(shelf, { countedQuantity: 4 }));

    const { status, body } = await reconcile(count.id, reconcileBody());
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('CONFLICT');
    expect((body as ErrorBody).error.message).toContain('no discrepancy');
    expect(await movements(shelf)).toHaveLength(1);
  });
});

describe('the snapshot is permanent', () => {
  it('does not move when the shop keeps trading', async () => {
    // The read must never recompute the variance against today's balance. The
    // count says what the counter saw relative to Ekon at capture time, and
    // that is a fact about a past moment.
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));

    await issue(shelf, 1);
    await receive(shelf, 5);
    expect(await onHand(shelf)).toBe(11);

    const reread = await app.inject({
      method: 'GET',
      url: `${COUNTS}?variantId=${shelf.variantId}`,
      cookies: owner.cookies,
    });
    const [item] = countPageSchema.parse(reread.json()).items;

    expect(item).toMatchObject({
      id: count.id,
      expectedQuantity: 7,
      countedQuantity: 6,
      variance: -1,
      status: 'OPEN',
    });
  });

  it('is refused by the database if anything tries to rewrite it', async () => {
    // The trigger from 0013. Nothing in the application updates these columns,
    // and the point of the trigger is that nothing ever can.
    const shelf = await newShelf();
    const count = await recordOk(countBody(shelf, { countedQuantity: 2 }));

    for (const [column, value] of [
      ['counted_quantity', 3],
      ['expected_quantity', 1],
      // A different variant: the trigger compares values, so rewriting a column
      // to what it already holds is not a rewrite.
      ['variant_id', newId()],
      ['counted_at', RECORDED_AT],
    ] as const) {
      await expect(
        db.pool.query(`UPDATE inventory_count_lines SET ${column} = $2 WHERE id = $1`, [
          count.id,
          value,
        ]),
        column,
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    }

    // The variance is generated, so it cannot even be named in an UPDATE.
    await expect(
      db.pool.query(`UPDATE inventory_count_lines SET variance = 5 WHERE id = $1`, [count.id]),
    ).rejects.toThrow();

    expect(await countRow(count.id)).toMatchObject({
      expected_quantity: 0,
      counted_quantity: 2,
      variance: 2,
    });
  });
});

describe('reconciling a discrepancy', () => {
  it('posts exactly one COUNT_RECONCILIATION of counted minus expected', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));

    const settled = await reconcileOk(
      count.id,
      reconcileBody({ reason: 'UNRECORDED_SALE', note: 'Sold on Saturday, never entered' }),
    );

    expect(settled.status).toBe('RECONCILED');
    expect(settled.reconciliation).toMatchObject({
      reason: 'UNRECORDED_SALE',
      note: 'Sold on Saturday, never entered',
    });
    expect(settled.reconciliation?.actor.id).toBe(owner.user.id);
    // The observation itself is untouched by the decision.
    expect(settled.expectedQuantity).toBe(7);
    expect(settled.countedQuantity).toBe(6);
    expect(settled.variance).toBe(-1);

    const posted = await movements(shelf);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      id: settled.reconciliation?.movementId,
      movement_type: 'COUNT_RECONCILIATION',
      quantity_delta: -1,
      quantity_before: 7,
      quantity_after: 6,
      reason_code: 'UNRECORDED_SALE',
      note: 'Sold on Saturday, never entered',
      user_id: owner.user.id,
    });
    // Business time is the count's own: the discrepancy existed when the shelf
    // was walked, not when somebody got round to accepting it.
    expect(posted[1]?.occurred_at.toISOString()).toBe(COUNTED_AT);
    expect(posted[1]?.recorded_at.toISOString()).toBe(RECORDED_AT);

    expect(await onHand(shelf)).toBe(6);
  });

  it('posts a positive delta for a positive variance', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 10 }));

    const settled = await reconcileOk(count.id, reconcileBody({ reason: 'MISSED_RECEIPT' }));

    const posted = await movements(shelf);
    expect(posted[1]).toMatchObject({
      movement_type: 'COUNT_RECONCILIATION',
      quantity_delta: 3,
      quantity_after: 10,
      reason_code: 'MISSED_RECEIPT',
    });
    expect(settled.status).toBe('RECONCILED');
    expect(await onHand(shelf)).toBe(10);
  });

  it('reconciles a shelf that never had a balance row', async () => {
    const shelf = await newShelf();
    const count = await recordOk(countBody(shelf, { countedQuantity: 4 }));

    await reconcileOk(count.id, reconcileBody({ reason: 'MISSED_RECEIPT' }));

    expect(await onHand(shelf)).toBe(4);
    expect(await movements(shelf)).toHaveLength(1);
  });

  it('keeps the ledger and the projection equal', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));
    await reconcileOk(count.id, reconcileBody());

    const { rows } = await db.pool.query<{ total: string }>(
      `SELECT coalesce(sum(quantity_delta), 0)::text AS total FROM inventory_movements
        WHERE variant_id = $1 AND location_id = $2`,
      [shelf.variantId, shelf.locationId],
    );
    expect(Number(rows[0]!.total)).toBe(await onHand(shelf));
  });

  it('refuses a count that does not exist, and a malformed id', async () => {
    const missing = await reconcile(newId(), reconcileBody());
    expect(missing.status).toBe(404);
    expect(errorCode(missing.body)).toBe('NOT_FOUND');

    const malformed = await app.inject({
      method: 'POST',
      url: `${COUNTS}/not-a-uuid/reconcile`,
      cookies: owner.cookies,
      payload: reconcileBody(),
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('refuses a second acceptance of the same discrepancy', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));
    const settled = await reconcileOk(count.id, reconcileBody());

    // A different operation id: a genuinely new command, not a retry.
    const { status, body } = await reconcile(count.id, reconcileBody({ reason: 'DAMAGED' }));
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('CONFLICT');
    expect((body as ErrorBody).error.message).toContain(settled.reconciliation!.movementId);

    // One movement for one discrepancy, and the original decision stands.
    expect(await movements(shelf)).toHaveLength(2);
    expect(await onHand(shelf)).toBe(6);
    expect(await countRow(count.id)).toMatchObject({ reconciliation_reason: 'SHRINKAGE' });
  });

  it('refuses to rewrite a settled decision, in the database', async () => {
    const shelf = await newShelf();
    await receive(shelf, 5);
    const count = await recordOk(countBody(shelf, { countedQuantity: 4 }));
    await reconcileOk(count.id, reconcileBody({ reason: 'DAMAGED' }));

    await expect(
      db.pool.query(
        `UPDATE inventory_count_lines SET reconciliation_reason = 'SHRINKAGE' WHERE id = $1`,
        [count.id],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });
});

describe('reconciliation applies the variance to current stock', () => {
  it('does not set the balance back to what was counted', async () => {
    // The test that protects the whole count principle from a future
    // "simplification". Seven expected, six counted, one legitimately sold in
    // between: the shelf ends at five, because five is what is actually there.
    const shelf = await newShelf();
    await receive(shelf, 7);

    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));
    expect(count.variance).toBe(-1);

    await issue(shelf, 1);
    expect(await onHand(shelf)).toBe(6);

    await reconcileOk(count.id, reconcileBody({ reason: 'UNRECORDED_SALE' }));

    expect(await onHand(shelf)).toBe(5);
    const posted = await movements(shelf);
    expect(posted[2]).toMatchObject({
      movement_type: 'COUNT_RECONCILIATION',
      quantity_delta: -1,
      quantity_before: 6,
      quantity_after: 5,
    });
  });

  it('is refused when the shelf can no longer absorb the variance', async () => {
    // An old negative variance can become impossible, and the stock floor still
    // applies (INV-8). Nothing is clamped, nothing is reduced, and the count is
    // not marked settled without a movement.
    const shelf = await newShelf();
    await receive(shelf, 10);
    const count = await recordOk(countBody(shelf, { countedQuantity: 2 }));
    expect(count.variance).toBe(-8);

    await issue(shelf, 5);
    expect(await onHand(shelf)).toBe(5);

    const request = reconcileBody();
    const { status, body } = await reconcile(count.id, request);

    expect(status).toBe(422);
    expect(errorCode(body)).toBe('INSUFFICIENT_STOCK');

    // Nothing moved, nothing settled, and nothing half-written.
    expect(await onHand(shelf)).toBe(5);
    expect(await movements(shelf)).toHaveLength(2);
    const row = await countRow(count.id);
    expect(row).toMatchObject({
      status: 'OPEN',
      reconciliation_reason: null,
      reconciled_by_user_id: null,
      reconciled_at: null,
      reconciliation_movement_id: null,
      reconciliation_operation_id: null,
    });
    // The whole transaction rolled back, so the operation id is free for a
    // corrected command once the sequence has been investigated.
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });

  it('settles once the sequence has been corrected', async () => {
    // The remedy the refusal points at: investigate the movements posted since,
    // correct them, then accept the discrepancy.
    const shelf = await newShelf();
    await receive(shelf, 10);
    const count = await recordOk(countBody(shelf, { countedQuantity: 2 }));
    const sale = await issue(shelf, 5);

    expect((await reconcile(count.id, reconcileBody())).status).toBe(422);

    // The sale was itself a mistake; reversing it puts the units back.
    const reversal = await app.inject({
      method: 'POST',
      url: '/api/inventory/reverse',
      cookies: owner.cookies,
      payload: { operationId: newId(), movementId: sale, occurredAt: COUNTED_AT },
    });
    expect(reversal.statusCode).toBe(201);
    expect(await onHand(shelf)).toBe(10);

    await reconcileOk(count.id, reconcileBody());
    expect(await onHand(shelf)).toBe(2);
  });
});

describe('idempotency', () => {
  it('records one observation for a retried command', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const request = countBody(shelf, { countedQuantity: 6 });

    const first = await recordOk(request);
    const replay = await recordOk(request);

    expect(replay).toEqual(first);
    const { rows } = await db.pool.query(
      `SELECT 1 FROM inventory_count_lines WHERE variant_id = $1`,
      [shelf.variantId],
    );
    expect(rows).toHaveLength(1);
  });

  it('answers a retry with the original expected quantity, not today’s balance', async () => {
    // The case that makes the settled-first rule necessary rather than merely
    // tidy: re-running the recording path after a receipt landed would produce
    // a different expected quantity for the same command.
    const shelf = await newShelf();
    await receive(shelf, 7);
    const request = countBody(shelf, { countedQuantity: 6 });
    const first = await recordOk(request);

    await receive(shelf, 4);

    const replay = await recordOk(request);
    expect(replay.expectedQuantity).toBe(7);
    expect(replay).toEqual(first);
  });

  it('refuses a recording id reused with a different count', async () => {
    const shelf = await newShelf();
    const request = countBody(shelf, { countedQuantity: 6 });
    await recordOk(request);

    const { status, body } = await record({ ...request, countedQuantity: 5 });
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
  });

  it('settles once for a retried reconciliation', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));
    const request = reconcileBody({ note: 'Two missing from the display' });

    const first = await reconcileOk(count.id, request);
    const replay = await reconcileOk(count.id, request);

    expect(replay).toEqual(first);
    expect(await movements(shelf)).toHaveLength(2);
    expect(await onHand(shelf)).toBe(6);
  });

  it('refuses a reconciliation id reused with a different decision', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));
    const request = reconcileBody({ reason: 'SHRINKAGE' });
    await reconcileOk(count.id, request);

    const { status, body } = await reconcile(count.id, { ...request, reason: 'DAMAGED' });
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect(await movements(shelf)).toHaveLength(2);
  });

  it('claims the reconciliation operation under its own type', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));
    const request = reconcileBody();
    const settled = await reconcileOk(count.id, request);

    expect(await operations(request.operationId as string)).toEqual([
      {
        operation_type: COUNT_RECONCILE_OPERATION_TYPE,
        result_resource_type: 'inventory_movement',
        result_resource_id: settled.reconciliation!.movementId,
      },
    ]);
  });
});

describe('lifecycle', () => {
  it('counts DISCONTINUED merchandise, which is still real stock', async () => {
    const shelf = await newShelf();
    await receive(shelf, 5);
    await db.pool.query(
      `UPDATE product_variants SET lifecycle_status = 'DISCONTINUED' WHERE id = $1`,
      [shelf.variantId],
    );

    const count = await recordOk(countBody(shelf, { countedQuantity: 4 }));
    expect(count.variance).toBe(-1);

    await reconcileOk(count.id, reconcileBody());
    expect(await onHand(shelf)).toBe(4);
  });

  it('refuses to count ARCHIVED merchandise', async () => {
    const shelf = await newShelf({ variantLifecycle: 'ARCHIVED' });
    const request = countBody(shelf);
    const { status, body } = await record(request);

    expect(status).toBe(409);
    expect(errorCode(body)).toBe('CONFLICT');
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });

  it('refuses to reconcile once the merchandise has been archived', async () => {
    // Archiving asserts the merchandise holds nothing anywhere, so a
    // reconciliation would put stock behind a status that says there is none.
    const shelf = await newShelf();
    const count = await recordOk(countBody(shelf, { countedQuantity: 3 }));
    await db.pool.query(`UPDATE product_variants SET lifecycle_status = 'ARCHIVED' WHERE id = $1`, [
      shelf.variantId,
    ]);

    const { status, body } = await reconcile(count.id, reconcileBody({ reason: 'MISSED_RECEIPT' }));
    expect(status).toBe(409);
    expect((body as ErrorBody).error.message).toContain('DISCONTINUED');
    expect(await countRow(count.id)).toMatchObject({ status: 'OPEN' });
  });

  it('refuses to count a closed shelf, and still settles one closed after the count', async () => {
    const closed = await newShelf({ locationActive: false });
    const refused = await record(countBody(closed));
    expect(refused.status).toBe(409);

    // A shelf closed *after* the observation must not make the discrepancy
    // permanently unresolvable: the count was taken while it was open, and
    // closing a location is a decision about the future.
    const shelf = await newShelf();
    await receive(shelf, 5);
    const count = await recordOk(countBody(shelf, { countedQuantity: 4 }));
    await db.pool.query(`UPDATE inventory_locations SET is_active = false WHERE id = $1`, [
      shelf.locationId,
    ]);

    await reconcileOk(count.id, reconcileBody());
    expect(await onHand(shelf)).toBe(4);
  });
});

describe('traceability', () => {
  it('links the count to its movement, and the movement back to the count', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));
    const settled = await reconcileOk(count.id, reconcileBody());
    const movementId = settled.reconciliation!.movementId;

    // Count → movement, stored.
    expect(await countRow(count.id)).toMatchObject({
      reconciliation_movement_id: movementId,
      reconciliation_movement_type: 'COUNT_RECONCILIATION',
    });

    // Movement → count, read back through the unique index in history's own
    // query rather than stored a second time on the ledger.
    const history = await app.inject({
      method: 'GET',
      url: `/api/inventory/movements?variantId=${shelf.variantId}&movementType=COUNT_RECONCILIATION`,
      cookies: owner.cookies,
    });
    const page = movementHistoryPageSchema.parse(history.json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: movementId,
      movementType: 'COUNT_RECONCILIATION',
      countId: count.id,
      reasonCode: 'SHRINKAGE',
    });
  });

  it('leaves countId null on every movement that is not a reconciliation', async () => {
    const shelf = await newShelf();
    await receive(shelf, 3);

    const history = await app.inject({
      method: 'GET',
      url: `/api/inventory/movements?variantId=${shelf.variantId}`,
      cookies: owner.cookies,
    });
    const page = movementHistoryPageSchema.parse(history.json());
    expect(page.items[0]?.countId).toBeNull();
  });

  it('refuses, in the database, to point a count at a movement of another type', async () => {
    const shelf = await newShelf();
    const receipt = await receive(shelf, 3);
    const count = await recordOk(countBody(shelf, { countedQuantity: 2 }));

    await expect(
      db.pool.query(
        `UPDATE inventory_count_lines
            SET reconciled_at = $2, reconciliation_reason = 'SHRINKAGE',
                reconciled_by_user_id = $3, reconciliation_operation_id = $4,
                reconciliation_movement_id = $5
          WHERE id = $1`,
        [count.id, RECORDED_AT, owner.user.id, newId(), receipt],
      ),
    ).rejects.toThrow();
  });
});

describe('reversing a reconciliation', () => {
  it('undoes the stock and leaves the count evidence exactly as it was', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordOk(countBody(shelf, { countedQuantity: 6 }));
    const settled = await reconcileOk(count.id, reconcileBody());
    const movementId = settled.reconciliation!.movementId;
    const before = await countRow(count.id);

    const reversal = await app.inject({
      method: 'POST',
      url: '/api/inventory/reverse',
      cookies: owner.cookies,
      payload: { operationId: newId(), movementId, occurredAt: COUNTED_AT },
    });
    expect(reversal.statusCode).toBe(201);

    // The stock is back.
    expect(await onHand(shelf)).toBe(7);

    // And the count still says what it always said. It is not walked back to
    // OPEN and it is not rewritten: the observation happened, the decision was
    // made, and that a later correction undid its effect is the ledger's story
    // to tell.
    expect(await countRow(count.id)).toEqual(before);

    const history = await app.inject({
      method: 'GET',
      url: `/api/inventory/movements?variantId=${shelf.variantId}`,
      cookies: owner.cookies,
    });
    const page = movementHistoryPageSchema.parse(history.json());
    const reconciliation = page.items.find((item) => item.id === movementId);
    expect(reconciliation).toMatchObject({ countId: count.id });
    expect(reconciliation?.reversedByMovementId).not.toBeNull();
  });
});

describe('authorization', () => {
  it('refuses an anonymous caller everywhere', async () => {
    const shelf = await newShelf();
    const count = await recordOk(countBody(shelf, { countedQuantity: 1 }));

    for (const call of [
      app.inject({ method: 'POST', url: COUNTS, payload: countBody(shelf) }),
      app.inject({ method: 'GET', url: COUNTS }),
      app.inject({
        method: 'POST',
        url: `${COUNTS}/${count.id}/reconcile`,
        payload: reconcileBody(),
      }),
    ]) {
      expect((await call).statusCode).toBe(401);
    }
  });

  it('refuses an employee, who may read counts but not perform one', async () => {
    // `inventory.count` is deliberately withheld from EMPLOYEE by the seed:
    // counting is an audit of the records themselves, and a shop decides who
    // performs one. Reading is `inventory.read`, the same capability that
    // answers what is on the shelf.
    const shelf = await newShelf();
    await receive(shelf, 5);
    const count = await recordOk(countBody(shelf, { countedQuantity: 4 }));

    const recorded = await record(countBody(shelf), employee);
    expect(recorded.status).toBe(403);
    expect(errorCode(recorded.body)).toBe('FORBIDDEN');

    const reconciled = await reconcile(count.id, reconcileBody(), employee);
    expect(reconciled.status).toBe(403);

    const read = await app.inject({ method: 'GET', url: COUNTS, cookies: employee.cookies });
    expect(read.statusCode).toBe(200);
  });

  it('allows a manager, and records them as the actor', async () => {
    const shelf = await newShelf();
    await receive(shelf, 5);
    const count = await recordOk(countBody(shelf, { countedQuantity: 3 }), manager);
    expect(count.counter.id).toBe(manager.user.id);

    const settled = await reconcileOk(count.id, reconcileBody(), manager);
    expect(settled.reconciliation?.actor.id).toBe(manager.user.id);

    const posted = await movements(shelf);
    expect(posted[1]?.user_id).toBe(manager.user.id);
  });
});
