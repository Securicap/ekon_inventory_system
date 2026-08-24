import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countRecordSchema, type CountRecord, type ErrorBody } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import type { DatabaseClient } from '../../src/platform/db/pool.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { runConcurrentlyBehindLock, waitForBlockedBackends } from '../helpers/ledgerConcurrency.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Two people accepting one discrepancy at the same time, and what happens when
 * the second half of a reconciliation fails.
 *
 * Two properties are proved here, and both are the kind that hold in testing
 * and fail in a shop:
 *
 *   **Exactly one movement per discrepancy.** A variance observed once must
 *   move the shelf once. Two managers pressing the same button, each with their
 *   own operation id, is not a retry — it is two commands — and the loser has
 *   to be told the discrepancy was already settled rather than settling it
 *   again.
 *
 *   **The movement and the settled count are one fact.** A count marked
 *   reconciled with no movement behind it is a stock change the shop believes
 *   happened and did not; a movement whose count still reads unresolved is a
 *   stock change nobody can explain. Neither may ever be observable, including
 *   when the second write fails.
 *
 * Both are staged against real PostgreSQL, behind a barrier that asks the
 * database itself whether the commands are genuinely blocked before releasing
 * them. If the overlap never happens the barrier times out and the test fails
 * rather than passing quietly.
 */

const RECORDED_AT = '2026-08-03T12:00:00.000Z';
const COUNTED_AT = '2026-08-03T10:15:00.000Z';
const COUNTS = '/api/inventory/counts';

let db: TestDatabase;
let app: FastifyInstance;
let owner: TestSession;
/** A second person who may also count, so the race is two people rather than one. */
let manager: TestSession;

interface Shelf {
  variantId: string;
  locationId: string;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-K${skuCounter.toString().padStart(7, '0')}`;
}

async function newShelf(): Promise<Shelf> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, lifecycle_status, created_at, updated_at)
     VALUES ($1, 'Count race fixture', 'ACTIVE', $2, $2)`,
    [productId, RECORDED_AT],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, lifecycle_status, created_at, updated_at)
     VALUES ($1, $2, $3, '[]', 'ACTIVE', $4, $4)`,
    [variantId, productId, nextSku(), RECORDED_AT],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, 'Count race shelf', false, true, $2, $2)`,
    [locationId, RECORDED_AT],
  );

  return { variantId, locationId };
}

interface Injected {
  status: number;
  body: unknown;
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

async function recordCount(shelf: Shelf, countedQuantity: number): Promise<CountRecord> {
  const response = await app.inject({
    method: 'POST',
    url: COUNTS,
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId: shelf.variantId,
      locationId: shelf.locationId,
      countedQuantity,
      countedAt: COUNTED_AT,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return countRecordSchema.parse(response.json());
}

async function reconcile(
  countId: string,
  session: TestSession,
  overrides: Record<string, unknown> = {},
): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: `${COUNTS}/${countId}/reconcile`,
    cookies: session.cookies,
    payload: { operationId: newId(), reason: 'SHRINKAGE', ...overrides },
  });
  return { status: response.statusCode, body: response.json() };
}

async function reconciliationMovements(shelf: Shelf): Promise<{ id: string; delta: number }[]> {
  const { rows } = await db.pool.query<{ id: string; quantity_delta: number }>(
    `SELECT id, quantity_delta FROM inventory_movements
      WHERE variant_id = $1 AND location_id = $2 AND movement_type = 'COUNT_RECONCILIATION'`,
    [shelf.variantId, shelf.locationId],
  );
  return rows.map((row) => ({ id: row.id, delta: row.quantity_delta }));
}

async function onHand(shelf: Shelf): Promise<number | undefined> {
  const { rows } = await db.pool.query<{ quantity_on_hand: number }>(
    `SELECT quantity_on_hand FROM inventory_balances WHERE variant_id = $1 AND location_id = $2`,
    [shelf.variantId, shelf.locationId],
  );
  return rows[0]?.quantity_on_hand;
}

async function ledgerTotal(shelf: Shelf): Promise<number> {
  const { rows } = await db.pool.query<{ total: string }>(
    `SELECT coalesce(sum(quantity_delta), 0)::text AS total FROM inventory_movements
      WHERE variant_id = $1 AND location_id = $2`,
    [shelf.variantId, shelf.locationId],
  );
  return Number(rows[0]!.total);
}

async function countRow(id: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT * FROM inventory_count_lines WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** Locks the count row, which is what every reconciliation must pass through. */
const lockCountRow =
  (countId: string) =>
  async (holder: DatabaseClient): Promise<void> => {
    const { rowCount } = await holder.query(
      `SELECT 1 FROM inventory_count_lines WHERE id = $1 FOR UPDATE`,
      [countId],
    );
    // The barrier is worthless if there was no row to lock.
    expect(rowCount).toBe(1);
  };

function statusOf(result: PromiseSettledResult<Injected>): number {
  return result.status === 'fulfilled' ? result.value.status : 500;
}

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool, { role: 'OWNER' });
  manager = await createTestSession(db.pool, { role: 'MANAGER' });
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

describe('two people reconciling one discrepancy', () => {
  it('settles it once, with one movement, and refuses the other', async () => {
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordCount(shelf, 6);

    const results = await runConcurrentlyBehindLock<Injected>(db.pool, lockCountRow(count.id), [
      () => reconcile(count.id, owner, { reason: 'SHRINKAGE' }),
      () => reconcile(count.id, manager, { reason: 'UNRECORDED_SALE' }),
    ]);

    const answers = results.map(statusOf);
    expect(answers.filter((status) => status === 200)).toHaveLength(1);
    expect(answers.filter((status) => status === 409)).toHaveLength(1);

    // One discrepancy, one movement — never two, whatever the interleaving.
    const posted = await reconciliationMovements(shelf);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.delta).toBe(-1);

    expect(await onHand(shelf)).toBe(6);
    expect(await ledgerTotal(shelf)).toBe(6);

    // And the count names the one movement that settled it.
    expect(await countRow(count.id)).toMatchObject({
      status: 'RECONCILED',
      reconciliation_movement_id: posted[0]!.id,
    });
  });

  it('gives the loser a conflict naming the decision that won', async () => {
    const shelf = await newShelf();
    await receive(shelf, 5);
    const count = await recordCount(shelf, 3);

    const results = await runConcurrentlyBehindLock<Injected>(db.pool, lockCountRow(count.id), [
      () => reconcile(count.id, owner),
      () => reconcile(count.id, manager),
    ]);

    const loser = results
      .map((result) => (result.status === 'fulfilled' ? result.value : null))
      .find((value) => value?.status === 409);

    expect(loser).toBeDefined();
    expect((loser!.body as ErrorBody).error.code).toBe('CONFLICT');
    // Not a 500, and not a constraint name: a business answer somebody at a
    // counter can act on.
    expect((loser!.body as ErrorBody).error.message).toContain('already reconciled');
    expect(await reconciliationMovements(shelf)).toHaveLength(1);
  });

  it('answers a genuine retry that queued behind its own first attempt', async () => {
    // Same operation id twice, overlapping. The pre-transaction lookup finds
    // nothing because the first attempt has not committed yet, so the second
    // reaches the count lock and finds the count settled by *itself* — which is
    // an answer, not a conflict. A `409` here would tell a client its own
    // successful command had failed.
    const shelf = await newShelf();
    await receive(shelf, 9);
    const count = await recordCount(shelf, 8);
    const operationId = newId();

    const results = await runConcurrentlyBehindLock<Injected>(db.pool, lockCountRow(count.id), [
      () => reconcile(count.id, owner, { operationId }),
      () => reconcile(count.id, owner, { operationId }),
    ]);

    expect(results.map(statusOf)).toEqual([200, 200]);
    expect(await reconciliationMovements(shelf)).toHaveLength(1);
    expect(await onHand(shelf)).toBe(8);
  });

  it('still refuses one operation id used for two different decisions', async () => {
    // The same overlap, with the bodies disagreeing. The winner's decision
    // stands and the other is refused as a replay with a different body rather
    // than being handed somebody else's reason.
    const shelf = await newShelf();
    await receive(shelf, 9);
    const count = await recordCount(shelf, 8);
    const operationId = newId();

    const results = await runConcurrentlyBehindLock<Injected>(db.pool, lockCountRow(count.id), [
      () => reconcile(count.id, owner, { operationId, reason: 'SHRINKAGE' }),
      () => reconcile(count.id, owner, { operationId, reason: 'DAMAGED' }),
    ]);

    const answers = results.map(statusOf);
    expect(answers).toContain(200);
    expect(answers).toContain(409);
    expect(await reconciliationMovements(shelf)).toHaveLength(1);
  });
});

describe('a reconciliation is one fact or none', () => {
  it('rolls the movement back when the count cannot be settled', async () => {
    // The failure this design exists to survive: the movement is posted, and
    // the second half — writing the decision onto the count — fails. A trigger
    // installed for the length of this test forces exactly that, at exactly
    // that seam.
    //
    // Nothing may survive it. Not the movement, not the balance change, not the
    // operation claim: a `COUNT_RECONCILIATION` whose count still reads `OPEN`
    // is a stock change nobody can explain, and that is worse than the failure
    // it came from.
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordCount(shelf, 6);

    await db.pool.query(`
      CREATE FUNCTION count_settlement_fails() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced failure after the movement was posted';
      END;
      $$;
      CREATE TRIGGER count_settlement_fails
        BEFORE UPDATE ON inventory_count_lines
        FOR EACH ROW EXECUTE FUNCTION count_settlement_fails();
    `);

    let refused: Injected;
    try {
      refused = await reconcile(count.id, owner);
    } finally {
      await db.pool.query(`
        DROP TRIGGER count_settlement_fails ON inventory_count_lines;
        DROP FUNCTION count_settlement_fails();
      `);
    }

    // An unexpected failure, reported as one — never a partial success.
    expect(refused.status).toBe(500);

    expect(await reconciliationMovements(shelf)).toHaveLength(0);
    expect(await onHand(shelf)).toBe(7);
    expect(await ledgerTotal(shelf)).toBe(7);
    expect(await countRow(count.id)).toMatchObject({
      status: 'OPEN',
      reconciled_at: null,
      reconciliation_movement_id: null,
      reconciliation_operation_id: null,
    });

    // And with the injected failure gone, the same discrepancy settles
    // normally — the count was never damaged by the attempt.
    const settled = await reconcile(count.id, owner);
    expect(settled.status).toBe(200);
    expect(await onHand(shelf)).toBe(6);
    expect(await reconciliationMovements(shelf)).toHaveLength(1);
  });

  it('leaves the count OPEN when the movement itself is refused', async () => {
    // The inverse seam, and the one that happens in real shops: the stock floor
    // refuses the movement, so there is nothing to settle the count with — and
    // the count must not be marked reconciled anyway.
    const shelf = await newShelf();
    await receive(shelf, 10);
    const count = await recordCount(shelf, 2);

    await app.inject({
      method: 'POST',
      url: '/api/inventory/remove',
      cookies: owner.cookies,
      payload: {
        operationId: newId(),
        variantId: shelf.variantId,
        locationId: shelf.locationId,
        quantity: 5,
        reason: 'SOLD',
        occurredAt: COUNTED_AT,
      },
    });

    const refused = await reconcile(count.id, owner);
    expect(refused.status).toBe(422);

    expect(await reconciliationMovements(shelf)).toHaveLength(0);
    expect(await onHand(shelf)).toBe(5);
    expect(await countRow(count.id)).toMatchObject({ status: 'OPEN', reconciled_at: null });
  });
});

describe('recording a count while the shelf is moving', () => {
  it('snapshots a quantity that a concurrent posting is about to change', async () => {
    // The expected quantity has to be a coherent serialization point: read
    // under a shared lock, so a posting cannot land between the read and the
    // insert and leave the observation measured against a balance that was
    // never current.
    //
    // Staged the only way that proves it: a holder takes the balance row, a
    // receipt queues behind it, and the count queues behind the receipt. When
    // they are released the receipt commits first, so the count must see 12 and
    // not 7.
    const shelf = await newShelf();
    await receive(shelf, 7);

    const watcher = await db.pool.connect();
    const holder = await db.pool.connect();

    let counted: CountRecord;
    try {
      await holder.query('BEGIN');
      const { rowCount } = await holder.query(
        `SELECT 1 FROM inventory_balances WHERE variant_id = $1 AND location_id = $2 FOR UPDATE`,
        [shelf.variantId, shelf.locationId],
      );
      expect(rowCount).toBe(1);

      const receipt = app.inject({
        method: 'POST',
        url: '/api/inventory/receive',
        cookies: owner.cookies,
        payload: {
          operationId: newId(),
          variantId: shelf.variantId,
          locationId: shelf.locationId,
          quantity: 5,
          occurredAt: COUNTED_AT,
        },
      });
      receipt.catch(() => undefined);
      await waitForBlockedBackends(watcher, 1);

      const observation = app.inject({
        method: 'POST',
        url: COUNTS,
        cookies: owner.cookies,
        payload: {
          operationId: newId(),
          variantId: shelf.variantId,
          locationId: shelf.locationId,
          countedQuantity: 12,
          countedAt: COUNTED_AT,
        },
      });
      observation.catch(() => undefined);
      await waitForBlockedBackends(watcher, 2);

      await holder.query('ROLLBACK');

      expect((await receipt).statusCode).toBe(201);
      const response = await observation;
      expect(response.statusCode, response.payload).toBe(201);
      counted = countRecordSchema.parse(response.json());
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      watcher.release();
    }

    // Twelve expected, twelve counted: the count saw the shelf after the
    // receipt, which is what the lock guarantees. Reading the balance without
    // one could have recorded a variance of +5 against a stale 7.
    expect(counted.expectedQuantity).toBe(12);
    expect(counted.variance).toBe(0);
    expect(counted.status).toBe('MATCHED');
    expect(await onHand(shelf)).toBe(12);
  });

  it('does not hold the shelf while a discrepancy is investigated', async () => {
    // No count mode. The lock lives for the recording transaction and not one
    // moment longer, so the shop keeps trading against a counted shelf while
    // somebody works out where the missing unit went — which is exactly why
    // reconciliation applies the observed difference rather than setting the
    // balance to what was counted.
    const shelf = await newShelf();
    await receive(shelf, 7);
    const count = await recordCount(shelf, 6);
    expect(count.status).toBe('OPEN');

    await receive(shelf, 3);
    await app.inject({
      method: 'POST',
      url: '/api/inventory/remove',
      cookies: owner.cookies,
      payload: {
        operationId: newId(),
        variantId: shelf.variantId,
        locationId: shelf.locationId,
        quantity: 2,
        reason: 'SOLD',
        occurredAt: COUNTED_AT,
      },
    });

    expect(await onHand(shelf)).toBe(8);

    const settled = await reconcile(count.id, owner);
    expect(settled.status).toBe(200);
    // 8 + (6 − 7) = 7, not 6.
    expect(await onHand(shelf)).toBe(7);
  });
});
