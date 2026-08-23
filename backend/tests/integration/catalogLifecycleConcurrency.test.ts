import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductResponseSchema, type ErrorBody, type Product } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import type { DatabaseClient } from '../../src/platform/db/pool.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { runConcurrentlyBehindLock, waitForBlockedBackends } from '../helpers/ledgerConcurrency.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Archiving merchandise and posting stock against it, at the same time.
 *
 * The invariant, stated exactly: **after both commands settle, there is no
 * archived merchandise holding newly posted stock.** One of the two must
 * observe the other and refuse.
 *
 * The naive implementation passes every other test in this repository and fails
 * this one. `check that stock is zero, then archive` is a check-then-act race: a
 * receipt commits in the gap, the archive commits after it, and the shop has
 * archived merchandise sitting on a shelf with no screen willing to admit it
 * exists. The remedy is not a mutex — an in-memory lock protects one process,
 * and this system will not always be one process — but PostgreSQL's own row
 * locks, taken by both sides in one fixed order:
 *
 *   1. a lifecycle change locks the merchandise rows `FOR UPDATE`, and only
 *      then reads the balances;
 *   2. a posting workflow locks the same rows `FOR SHARE` inside its posting
 *      transaction, before it touches a balance.
 *
 * They therefore serialize on the **catalog** row rather than on the balance
 * row — which matters, because a shelf that has never held stock has no balance
 * row to contend for, and that is exactly the case an archive is most likely to
 * meet.
 *
 * **Both directions are staged separately, because they are protected by
 * different halves of that design**, and a suite that proved only one would be
 * proving the easy half:
 *
 *   _archive first_ — the posting workflow reads `ARCHIVED` under its own lock
 *   and refuses.
 *
 *   _posting first_ — the archive's balance read, taken after it finally gets
 *   the row, sees stock that committed while it was waiting. This is the half a
 *   check-then-act implementation gets wrong, and the reason the balance is read
 *   after the lock rather than before it.
 *
 * Every scenario is staged behind a real barrier: PostgreSQL itself is asked
 * whether the commands are blocked, through `pg_stat_activity`, before anything
 * is released. If the overlap never happens the barrier times out and the test
 * fails rather than passing quietly.
 */

const RECORDED_AT = '2026-08-03T12:00:00.000Z';
const OCCURRED_AT = '2026-08-03T10:15:00.000Z';

let db: TestDatabase;
let app: FastifyInstance;
let owner: TestSession;
let locationId: string;

interface Injected {
  status: number;
  body: unknown;
}

async function newProduct(name: string): Promise<Product> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/catalog/products',
    cookies: owner.cookies,
    payload: { name, variants: [{ attributes: {} }] },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return createProductResponseSchema.parse(response.json());
}

/** Locks the variant row, which is what a lifecycle change and a posting both take. */
const lockVariantRow =
  (variantId: string) =>
  async (holder: DatabaseClient): Promise<void> => {
    const { rowCount } = await holder.query(
      `SELECT 1 FROM product_variants WHERE id = $1 FOR UPDATE`,
      [variantId],
    );
    // The barrier is worthless if there was no row to lock.
    expect(rowCount).toBe(1);
  };

/** Locks the product row, for the product-level scenario. */
const lockProductRow =
  (productId: string) =>
  async (holder: DatabaseClient): Promise<void> => {
    const { rowCount } = await holder.query(`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, [
      productId,
    ]);
    expect(rowCount).toBe(1);
  };

async function receive(variantId: string, quantity: number): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/receive',
    cookies: owner.cookies,
    payload: { operationId: newId(), variantId, locationId, quantity, occurredAt: OCCURRED_AT },
  });
  return { status: response.statusCode, body: response.json() };
}

async function issue(variantId: string, quantity: number): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/remove',
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId,
      locationId,
      quantity,
      reason: 'SOLD',
      occurredAt: OCCURRED_AT,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
}

async function adjust(variantId: string, quantityDelta: number): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/adjust',
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId,
      locationId,
      quantityDelta,
      reason: 'MISSED_MOVEMENT',
      occurredAt: OCCURRED_AT,
    },
  });
  return { status: response.statusCode, body: response.json() };
}

async function archiveVariant(variantId: string): Promise<Injected> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/catalog/variants/${variantId}/lifecycle`,
    cookies: owner.cookies,
    payload: { lifecycleStatus: 'ARCHIVED' },
  });
  return { status: response.statusCode, body: response.json() };
}

async function archiveProduct(productId: string): Promise<Injected> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/catalog/products/${productId}/lifecycle`,
    cookies: owner.cookies,
    payload: { lifecycleStatus: 'ARCHIVED' },
  });
  return { status: response.statusCode, body: response.json() };
}

async function lifecycleOf(variantId: string): Promise<string> {
  const { rows } = await db.pool.query<{ lifecycle_status: string }>(
    `SELECT lifecycle_status FROM product_variants WHERE id = $1`,
    [variantId],
  );
  return rows[0]!.lifecycle_status;
}

async function productLifecycleOf(productId: string): Promise<string> {
  const { rows } = await db.pool.query<{ lifecycle_status: string }>(
    `SELECT lifecycle_status FROM products WHERE id = $1`,
    [productId],
  );
  return rows[0]!.lifecycle_status;
}

async function onHand(variantId: string): Promise<number> {
  const { rows } = await db.pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(quantity_on_hand), 0)::int AS total
       FROM inventory_balances WHERE variant_id = $1`,
    [variantId],
  );
  return rows[0]!.total;
}

/** The ledger's own account of the same quantity, so the projection can be checked against it. */
async function ledgerTotal(variantId: string): Promise<number> {
  const { rows } = await db.pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(quantity_delta), 0)::int AS total
       FROM inventory_movements WHERE variant_id = $1`,
    [variantId],
  );
  return rows[0]!.total;
}

function statusOf(result: PromiseSettledResult<Injected>): number {
  return result.status === 'fulfilled' ? result.value.status : 500;
}

/**
 * Stages the *posting first* direction, which the shared barrier cannot.
 *
 * `runConcurrentlyBehindLock` releases every attempt at once, and from there the
 * archive always reaches the merchandise row first whatever order they are
 * launched in — it opens a transaction and locks immediately, while a posting
 * workflow first answers its replay lookup, checks its location, and claims its
 * operation. That is a fact about the two workflows, not a scheduling accident,
 * so it cannot be flipped by reordering.
 *
 * So the posting is let through the catalog lock and stopped one step later, on
 * the **balance** row, by a holder transaction. While it sits there holding
 * `FOR SHARE` on the merchandise, the archive is launched and queues behind it
 * on `FOR UPDATE`. Releasing the holder lets the posting commit, and the archive
 * then reads a balance that changed while it was waiting — which is precisely
 * the read a check-then-act implementation would have made too early.
 *
 * The variant must already have a balance row for the holder to lock, so the
 * caller stocks it and empties it first. A zero balance row is the honest setup
 * anyway: it is what merchandise looks like on the day somebody decides to
 * archive it.
 */
async function postingReachesTheMerchandiseFirst(
  variantId: string,
  posting: () => Promise<Injected>,
  archive: () => Promise<Injected>,
): Promise<{ posting: Injected; archive: Injected }> {
  const watcher = await db.pool.connect();
  const holder = await db.pool.connect();

  try {
    await holder.query('BEGIN');
    const { rowCount } = await holder.query(
      `SELECT 1 FROM inventory_balances WHERE variant_id = $1 AND location_id = $2 FOR UPDATE`,
      [variantId, locationId],
    );
    // Without a balance row to hold, nothing below is staged at all.
    expect(rowCount).toBe(1);

    const running = posting();
    running.catch(() => undefined);
    // The posting is now past the catalog locks and stopped on the balance row.
    await waitForBlockedBackends(watcher, 1);

    const archiving = archive();
    archiving.catch(() => undefined);
    // And the archive is queued behind the merchandise lock the posting holds.
    await waitForBlockedBackends(watcher, 2);

    await holder.query('ROLLBACK');

    return { posting: await running, archive: await archiving };
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    watcher.release();
  }
}

/** Leaves the variant with a balance row reading zero — stocked, then emptied. */
async function emptyBalanceRow(variantId: string): Promise<void> {
  expect((await receive(variantId, 2)).status).toBe(201);
  await issue(variantId, 2);
  expect(await onHand(variantId)).toBe(0);
}

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool, { role: 'OWNER' });
  app = await buildApp({
    config: { ...loadConfig(), LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock: fixedClock(new Date(RECORDED_AT)),
  });

  const locations = await app.inject({
    method: 'GET',
    url: '/api/inventory/locations',
    cookies: owner.cookies,
  });
  locationId = (locations.json() as { id: string; isDefault: boolean }[]).find(
    (location) => location.isDefault,
  )!.id;
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('the archive reaches the merchandise first', () => {
  it('refuses the receipt that was posting against it', async () => {
    const product = await newProduct('Archive Wins Variant');
    const variantId = product.variants[0]!.id;

    const results = await runConcurrentlyBehindLock<Injected>(db.pool, lockVariantRow(variantId), [
      () => archiveVariant(variantId),
      () => receive(variantId, 4),
    ]);
    const [archive, receipt] = results.map(statusOf);

    expect(archive).toBe(200);
    expect(receipt).toBe(409);
    expect(await lifecycleOf(variantId)).toBe('ARCHIVED');
    expect(await onHand(variantId)).toBe(0);
    expect(await ledgerTotal(variantId)).toBe(0);
  });

  it('refuses an upward adjustment just as it refuses a receipt', async () => {
    // An `ADJUSTMENT_IN` puts stock on a shelf just as surely as a receipt
    // does, so it passes through the same lock and the same rule. A design that
    // had only remembered receiving would leave this hole open.
    const product = await newProduct('Archive Wins Adjustment');
    const variantId = product.variants[0]!.id;

    const results = await runConcurrentlyBehindLock<Injected>(db.pool, lockVariantRow(variantId), [
      () => archiveVariant(variantId),
      () => adjust(variantId, 3),
    ]);
    const [archive, adjustment] = results.map(statusOf);

    expect(archive).toBe(200);
    expect(adjustment).toBe(409);
    expect(await onHand(variantId)).toBe(0);
  });

  it('refuses a receipt against a variant of the product being archived', async () => {
    // The product archive locks the product row and then its variants; a
    // posting transaction locks the product before the variant. Both take them
    // in the same order, which is why this queues instead of deadlocking.
    const product = await newProduct('Archive Wins Product');
    const variantId = product.variants[0]!.id;

    const results = await runConcurrentlyBehindLock<Injected>(db.pool, lockProductRow(product.id), [
      () => archiveProduct(product.id),
      () => receive(variantId, 6),
    ]);
    const [archive, receipt] = results.map(statusOf);

    expect(archive).toBe(200);
    expect(receipt).toBe(409);
    expect(await productLifecycleOf(product.id)).toBe('ARCHIVED');
    expect(await onHand(variantId)).toBe(0);
  });
});

describe('the posting reaches the merchandise first', () => {
  it('refuses the variant archive, which sees stock that committed while it waited', async () => {
    // The half a check-then-act implementation gets wrong: the balance this
    // archive reads is one that changed after it asked for the row and before
    // it got it.
    const product = await newProduct('Posting Wins Variant');
    const variantId = product.variants[0]!.id;
    await emptyBalanceRow(variantId);

    const { posting, archive } = await postingReachesTheMerchandiseFirst(
      variantId,
      () => receive(variantId, 4),
      () => archiveVariant(variantId),
    );

    expect(posting.status).toBe(201);
    expect(archive.status).toBe(409);
    expect((archive.body as ErrorBody).error.message).toContain('4 unit');

    expect(await lifecycleOf(variantId)).toBe('ACTIVE');
    expect(await onHand(variantId)).toBe(4);
    expect(await ledgerTotal(variantId)).toBe(4);
  });

  it('refuses the product archive for stock posted against one of its variants', async () => {
    const product = await newProduct('Posting Wins Product');
    const variantId = product.variants[0]!.id;
    await emptyBalanceRow(variantId);

    const { posting, archive } = await postingReachesTheMerchandiseFirst(
      variantId,
      () => receive(variantId, 5),
      () => archiveProduct(product.id),
    );

    expect(posting.status).toBe(201);
    expect(archive.status).toBe(409);
    expect((archive.body as ErrorBody).error.message).toContain('1 variant');

    expect(await productLifecycleOf(product.id)).toBe('ACTIVE');
    expect(await onHand(variantId)).toBe(5);
  });

  it('refuses the archive after an upward adjustment as well', async () => {
    const product = await newProduct('Posting Wins Adjustment');
    const variantId = product.variants[0]!.id;
    await emptyBalanceRow(variantId);

    const { posting, archive } = await postingReachesTheMerchandiseFirst(
      variantId,
      () => adjust(variantId, 2),
      () => archiveVariant(variantId),
    );

    expect(posting.status).toBe(201);
    expect(archive.status).toBe(409);
    expect(await lifecycleOf(variantId)).toBe('ACTIVE');
    expect(await onHand(variantId)).toBe(2);
  });
});

describe('two lifecycle changes at once', () => {
  it('serializes rather than deadlocking, and the second is a no-op', async () => {
    // Neither can produce stock, so the property that matters is only that both
    // transactions take their locks in the same order and therefore queue: the
    // second finds the merchandise already archived and answers the declarative
    // no-op rather than failing.
    const product = await newProduct('Two Archives');

    const results = await runConcurrentlyBehindLock<Injected>(db.pool, lockProductRow(product.id), [
      () => archiveProduct(product.id),
      () => archiveProduct(product.id),
    ]);

    expect(results.map(statusOf)).toEqual([200, 200]);
    expect(await productLifecycleOf(product.id)).toBe('ARCHIVED');
  });
});
