import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLedgerService,
  type LedgerService,
  type PostedMovement,
  type PostMovementCommand,
} from '../../src/modules/inventory/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import type { DatabaseClient } from '../../src/platform/db/pool.js';
import { AppError } from '../../src/platform/http/errors.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Concurrency behaviour of the posting engine, against real PostgreSQL.
 *
 * These tests prove one thing: that correctness under concurrent writers comes
 * from the row lock on `inventory_balances`, at READ COMMITTED, with no retry
 * loop and no isolation change. Nothing here tests distributed behaviour — the
 * guarantees are exactly PostgreSQL's transaction and row-lock semantics, on one
 * database.
 *
 * `Promise.all` alone would not prove anything: the calls might simply run one
 * after another and pass for the wrong reason. So every scenario forces genuine
 * overlap. A separate transaction takes the contended lock first, the commands
 * are launched, and the test waits until PostgreSQL itself reports that all of
 * them are blocked on a lock — read from `pg_stat_activity`, not guessed at
 * with a sleep — before releasing. If the overlap does not happen, the barrier
 * times out and the test fails rather than passing quietly.
 */

const OCCURRED_AT = new Date('2026-08-04T10:00:00.000Z');
/** What the injected clock reads. Fixture rows reuse it; nothing depends on it. */
const RECORDED_AT = new Date('2026-08-04T12:00:00.000Z');

/** Bounded safety guard on the barrier. Reached only when overlap never happens. */
const BLOCKED_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;

let db: TestDatabase;
let ledger: LedgerService;

/**
 * The real UUIDv7 generator, with every id it hands out recorded.
 *
 * Concurrent commands must not be told apart by which id they were given — that
 * would be an assumption about scheduling — so nothing here pins an id. The log
 * exists to count generations and to name the ids that were minted but never
 * committed. `push` is safe under this concurrency: it is one event loop.
 */
const generatedIds: string[] = [];

function generateId(): string {
  const id = newId();
  generatedIds.push(id);
  return id;
}

/** Ids minted while `run` was in flight, in the order the engine asked for them. */
async function idsGeneratedBy<T>(run: () => Promise<T>): Promise<{ result: T; ids: string[] }> {
  const before = generatedIds.length;
  const result = await run();
  return { result, ids: generatedIds.slice(before) };
}

interface Chain {
  variantId: string;
  locationId: string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-C${skuCounter.toString().padStart(7, '0')}`;
}

async function newChain(): Promise<Chain> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1, 'Concurrency fixture', $2, $2)`,
    [productId, RECORDED_AT],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
     VALUES ($1, $2, $3, '[]', $4, $4)`,
    [variantId, productId, nextSku(), RECORDED_AT],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, 'Concurrency fixture location', false, true, $2, $2)`,
    [locationId, RECORDED_AT],
  );

  return { variantId, locationId };
}

function command(chain: Chain, overrides: Partial<PostMovementCommand> = {}): PostMovementCommand {
  return {
    operationId: newId(),
    operationType: 'inventory.post_movement',
    requestHash: 'a'.repeat(64),
    variantId: chain.variantId,
    locationId: chain.locationId,
    movementType: 'RECEIPT',
    quantityDelta: 5,
    reasonCode: null,
    note: null,
    userId: newId(),
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

// --- Overlap coordination ---------------------------------------------------

/**
 * Waits until PostgreSQL reports `expected` backends blocked on a lock in this
 * test database. This is the barrier: it is the database confirming that the
 * commands really are contending, rather than the test hoping they are.
 */
async function waitForBlockedBackends(watcher: DatabaseClient, expected: number): Promise<void> {
  const deadline = Date.now() + BLOCKED_TIMEOUT_MS;
  let seen = 0;

  for (;;) {
    const { rows } = await watcher.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'`,
    );
    seen = Number(rows[0]!.count);
    if (seen >= expected) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${expected} transactions to block on a lock; saw ${seen}. ` +
          'The commands did not overlap, so this scenario proved nothing.',
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Runs `posts` concurrently with guaranteed overlap.
 *
 * `takeBlock` runs first, in its own transaction, and takes whatever lock the
 * posts will contend for. Every post is then launched, the barrier waits until
 * all of them are blocked, and only then is the blocking transaction rolled
 * back — releasing them into a genuine race.
 */
async function postConcurrently<T>(
  takeBlock: (holder: DatabaseClient) => Promise<void>,
  posts: Array<() => Promise<T>>,
): Promise<PromiseSettledResult<T>[]> {
  const watcher = await db.pool.connect();
  const holder = await db.pool.connect();

  try {
    await holder.query('BEGIN');
    await takeBlock(holder);

    const running = posts.map((post) => post());
    // Keep an early rejection from surfacing as an unhandled rejection while
    // the barrier is still waiting; `running` itself is still settled below.
    for (const promise of running) promise.catch(() => undefined);

    await waitForBlockedBackends(watcher, posts.length);
    await holder.query('ROLLBACK');

    return await Promise.allSettled(running);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    watcher.release();
  }
}

/** Locks an existing balance row, so posts to that chain queue behind it. */
const lockBalanceRow =
  (chain: Chain) =>
  async (holder: DatabaseClient): Promise<void> => {
    const { rowCount } = await holder.query(
      `SELECT 1 FROM inventory_balances
        WHERE variant_id = $1 AND location_id = $2
        FOR UPDATE`,
      [chain.variantId, chain.locationId],
    );
    // The barrier is worthless if there was no row to lock.
    expect(rowCount).toBe(1);
  };

/**
 * Inserts the balance row for a chain that has none and holds it uncommitted,
 * so posts block on the lazy-creation insert instead of on a row lock. Rolled
 * back with the holder, leaving the real first writer to create it.
 */
const holdPendingBalanceInsert =
  (chain: Chain) =>
  async (holder: DatabaseClient): Promise<void> => {
    await holder.query(
      `INSERT INTO inventory_balances
         (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
       VALUES ($1, $2, 0, NULL, $3)`,
      [chain.variantId, chain.locationId, RECORDED_AT],
    );
  };

// --- Reading persisted state ------------------------------------------------

interface MovementRow {
  id: string;
  quantity_delta: number;
  quantity_before: number;
  quantity_after: number;
  previous_movement_id: string | null;
  operation_id: string;
}

interface BalanceRow {
  quantity_on_hand: number;
  last_movement_id: string | null;
}

async function readBalance(chain: Chain): Promise<BalanceRow | undefined> {
  const { rows } = await db.pool.query<BalanceRow>(
    `SELECT quantity_on_hand, last_movement_id FROM inventory_balances
      WHERE variant_id = $1 AND location_id = $2`,
    [chain.variantId, chain.locationId],
  );
  return rows[0];
}

async function countBalanceRows(chain: Chain): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM inventory_balances
      WHERE variant_id = $1 AND location_id = $2`,
    [chain.variantId, chain.locationId],
  );
  return Number(rows[0]!.count);
}

async function countOperations(operationId: string): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM operations WHERE id = $1`,
    [operationId],
  );
  return Number(rows[0]!.count);
}

async function countMovementRows(movementId: string): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM inventory_movements WHERE id = $1`,
    [movementId],
  );
  return Number(rows[0]!.count);
}

/**
 * Reads a chain back from the database and asserts every structural invariant
 * that concurrency could break, then returns what it found.
 *
 * Nothing here depends on insert order or on which command won which position:
 * the chain is traversed by its own pointers, starting from the single opening
 * movement, which is the only ordering the ledger actually guarantees.
 */
async function auditChain(chain: Chain): Promise<{ ordered: MovementRow[]; sumDelta: number }> {
  const { rows } = await db.pool.query<MovementRow>(
    `SELECT id, quantity_delta, quantity_before, quantity_after, previous_movement_id, operation_id
       FROM inventory_movements
      WHERE variant_id = $1 AND location_id = $2`,
    [chain.variantId, chain.locationId],
  );

  const openings = rows.filter((row) => row.previous_movement_id === null);
  expect(openings).toHaveLength(1);

  const ids = new Set(rows.map((row) => row.id));
  const successorOf = new Map<string, MovementRow>();
  for (const row of rows) {
    if (row.previous_movement_id === null) continue;
    // No cross-chain predecessor: every predecessor is a movement of this chain.
    expect(ids.has(row.previous_movement_id)).toBe(true);
    // No predecessor has more than one successor.
    expect(successorOf.has(row.previous_movement_id)).toBe(false);
    successorOf.set(row.previous_movement_id, row);
  }

  // Walk from the opening movement to the end, checking each adjacent pair.
  const ordered: MovementRow[] = [];
  let current: MovementRow | undefined = openings[0]!;
  while (current) {
    ordered.push(current);
    const next: MovementRow | undefined = successorOf.get(current.id);
    if (next) {
      expect(next.previous_movement_id).toBe(current.id);
      expect(next.quantity_before).toBe(current.quantity_after);
    }
    current = next;
  }

  // The traversal reached every movement, so the chain is one line with no
  // fork and no detached segment.
  expect(ordered).toHaveLength(rows.length);

  let running = 0;
  for (const row of ordered) {
    expect(row.quantity_before).toBe(running);
    expect(row.quantity_before).toBeGreaterThanOrEqual(0);
    expect(row.quantity_after).toBeGreaterThanOrEqual(0);
    expect(row.quantity_after).toBe(row.quantity_before + row.quantity_delta);
    running = row.quantity_after;
  }

  const last = ordered[ordered.length - 1]!;
  const balance = await readBalance(chain);
  expect(balance).toBeDefined();
  // balance = last movement's after = sum of every delta.
  expect(balance!.quantity_on_hand).toBe(last.quantity_after);
  expect(balance!.quantity_on_hand).toBe(running);
  expect(balance!.last_movement_id).toBe(last.id);
  expect(balance!.quantity_on_hand).toBeGreaterThanOrEqual(0);

  return { ordered, sumDelta: running };
}

function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

function rejections<T>(results: PromiseSettledResult<T>[]): unknown[] {
  return results.filter((r) => r.status === 'rejected').map((r) => r.reason);
}

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = createLedgerService({
    pool: db.pool,
    clock: fixedClock(RECORDED_AT),
    generateId,
  });
});

afterAll(async () => {
  await db.drop();
});

describe('concurrent movements on one chain', () => {
  it('serializes through the balance lock into a single unbroken chain', async () => {
    const chain = await newChain();
    const opening = await ledger.postMovement(command(chain, { quantityDelta: 10 }));

    const deltas = [3, 4, 5, 6];
    const results = await postConcurrently(
      lockBalanceRow(chain),
      deltas.map((quantityDelta) => () => ledger.postMovement(command(chain, { quantityDelta }))),
    );

    expect(rejections(results)).toEqual([]);
    const posted = fulfilled(results);
    expect(posted).toHaveLength(deltas.length);
    // Each command produced exactly one movement, and its own.
    expect(new Set(posted.map((m) => m.id)).size).toBe(deltas.length);

    const { ordered, sumDelta } = await auditChain(chain);
    expect(ordered).toHaveLength(deltas.length + 1);
    expect(ordered[0]!.id).toBe(opening.id);
    expect(sumDelta).toBe(10 + deltas.reduce((a, b) => a + b, 0));

    // Every concurrent command landed somewhere in that one chain.
    const chainIds = new Set(ordered.map((m) => m.id));
    for (const movement of posted) expect(chainIds.has(movement.id)).toBe(true);
  });
});

describe('concurrent first movements onto an empty chain', () => {
  it('creates exactly one balance row and one opening movement', async () => {
    const chain = await newChain();
    expect(await readBalance(chain)).toBeUndefined();

    const deltas = [2, 3, 4];
    const results = await postConcurrently(
      // Nothing to lock yet: the writers contend on the lazy balance insert.
      holdPendingBalanceInsert(chain),
      deltas.map((quantityDelta) => () => ledger.postMovement(command(chain, { quantityDelta }))),
    );

    expect(rejections(results)).toEqual([]);
    expect(fulfilled(results)).toHaveLength(deltas.length);

    expect(await countBalanceRows(chain)).toBe(1);
    const { ordered, sumDelta } = await auditChain(chain);
    expect(ordered).toHaveLength(deltas.length);
    expect(sumDelta).toBe(deltas.reduce((a, b) => a + b, 0));
    expect(ordered[0]!.quantity_before).toBe(0);
  });
});

describe('concurrent withdrawals that cannot both fit', () => {
  it('lets exactly one through and refuses the other with INSUFFICIENT_STOCK', async () => {
    const chain = await newChain();
    await ledger.postMovement(command(chain, { quantityDelta: 10 }));

    const first = command(chain, {
      movementType: 'ADJUSTMENT_OUT',
      quantityDelta: -7,
      reasonCode: 'DAMAGE',
    });
    const second = command(chain, {
      movementType: 'ADJUSTMENT_OUT',
      quantityDelta: -7,
      reasonCode: 'DAMAGE',
    });

    const { result: results, ids } = await idsGeneratedBy(() =>
      postConcurrently(lockBalanceRow(chain), [
        () => ledger.postMovement(first),
        () => ledger.postMovement(second),
      ]),
    );

    const winners = fulfilled(results);
    const losers = rejections(results);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const failure = losers[0];
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('INSUFFICIENT_STOCK');

    // 10 - 7, and exactly one withdrawal was appended.
    const { ordered, sumDelta } = await auditChain(chain);
    expect(sumDelta).toBe(3);
    expect(ordered).toHaveLength(2);

    // Both commands claimed their own operation id, so both minted a movement
    // id. Only the winner's reached the database; the loser's was rolled back
    // in memory and belongs to no row anywhere.
    expect(ids).toHaveLength(2);
    const winner = winners[0]!;
    expect(ids).toContain(winner.id);
    const abandoned = ids.filter((id) => id !== winner.id);
    expect(abandoned).toHaveLength(1);
    expect(await countMovementRows(abandoned[0]!)).toBe(0);

    // The loser left nothing at all behind: no operation, no movement, and no
    // trace in the projection. Which command lost is not assumed — it is read
    // back from the operation rows.
    const loser = (await countOperations(first.operationId)) === 0 ? first : second;
    const won = loser === first ? second : first;
    expect(await countOperations(loser.operationId)).toBe(0);
    expect(await countOperations(won.operationId)).toBe(1);
  });
});

describe('concurrent identical retries', () => {
  it('posts once and answers every caller with the same movement', async () => {
    const chain = await newChain();
    await ledger.postMovement(command(chain, { quantityDelta: 10 }));

    // The same command body, sent four times, overlapping. This is a client
    // that retried while its first request was still in flight.
    const retried = command(chain, { quantityDelta: 6 });
    const { result: results, ids } = await idsGeneratedBy(() =>
      postConcurrently(
        lockBalanceRow(chain),
        Array.from({ length: 4 }, () => () => ledger.postMovement({ ...retried })),
      ),
    );

    expect(rejections(results)).toEqual([]);
    const returned = fulfilled(results);
    expect(returned).toHaveLength(4);

    // Exactly one of the four claimed the operation, so exactly one movement id
    // was ever minted — the other three found the claim taken and replayed,
    // which mints nothing.
    expect(ids).toHaveLength(1);
    const movementId = ids[0]!;
    expect(new Set(returned.map((m) => m.id))).toEqual(new Set([movementId]));

    // Every caller was told the same story about the stock.
    for (const movement of returned) {
      expect(movement.quantityBefore).toBe(10);
      expect(movement.quantityAfter).toBe(16);
    }

    expect(await countMovementRows(movementId)).toBe(1);
    const { ordered, sumDelta } = await auditChain(chain);
    expect(ordered).toHaveLength(2);
    // Stock moved exactly once, not four times.
    expect(sumDelta).toBe(16);

    const { rows } = await db.pool.query<{
      count: string;
      result_resource_type: string | null;
      result_resource_id: string | null;
    }>(
      `SELECT count(*) OVER ()::text AS count, result_resource_type, result_resource_id
         FROM operations WHERE id = $1`,
      [retried.operationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      count: '1',
      result_resource_type: 'inventory_movement',
      result_resource_id: movementId,
    });
  });
});

describe('concurrent reuse of one operation id for different requests', () => {
  it('lets exactly one through and refuses the other as a changed replay', async () => {
    const chain = await newChain();
    await ledger.postMovement(command(chain, { quantityDelta: 10 }));

    const operationId = newId();
    const first = command(chain, { operationId, quantityDelta: 4, requestHash: 'b'.repeat(64) });
    const second = command(chain, { operationId, quantityDelta: 9, requestHash: 'c'.repeat(64) });

    const { result: results, ids } = await idsGeneratedBy(() =>
      postConcurrently(lockBalanceRow(chain), [
        () => ledger.postMovement(first),
        () => ledger.postMovement(second),
      ]),
    );

    const winners = fulfilled(results);
    const losers = rejections(results);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toBeInstanceOf(AppError);
    expect((losers[0] as AppError).code).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect((losers[0] as AppError).status).toBe(409);

    const winner = winners[0]!;
    // Only the command that claimed the operation minted an id; the one refused
    // as a changed replay never got that far.
    expect(ids).toEqual([winner.id]);

    // One movement, and the stock reflects only the winning command.
    expect(await countMovementRows(winner.id)).toBe(1);
    const { ordered, sumDelta } = await auditChain(chain);
    expect(ordered).toHaveLength(2);
    expect(sumDelta).toBe(10 + winner.quantityDelta);

    // The single operation row belongs to the winner and points at its movement.
    // Which command won is read from the stored hash, never assumed.
    const { rows } = await db.pool.query<{
      request_hash: string;
      result_resource_id: string | null;
    }>(`SELECT request_hash, result_resource_id FROM operations WHERE id = $1`, [operationId]);
    expect(rows).toHaveLength(1);
    const winningCommand = rows[0]!.request_hash === first.requestHash ? first : second;
    expect(winner.quantityDelta).toBe(winningCommand.quantityDelta);
    expect(rows[0]).toMatchObject({
      request_hash: winningCommand.requestHash,
      result_resource_id: winner.id,
    });
  });
});

describe('independent stock chains', () => {
  it('does not block one chain behind a lock held on another', async () => {
    const blocked = await newChain();
    const independent = await newChain();
    await ledger.postMovement(command(blocked, { quantityDelta: 10 }));
    await ledger.postMovement(command(independent, { quantityDelta: 10 }));

    const watcher = await db.pool.connect();
    const holder = await db.pool.connect();

    let blockedSettled = false;
    let blockedPost: Promise<PostedMovement> | undefined;

    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM inventory_balances
          WHERE variant_id = $1 AND location_id = $2
          FOR UPDATE`,
        [blocked.variantId, blocked.locationId],
      );

      blockedPost = ledger.postMovement(command(blocked, { quantityDelta: 5 }));
      blockedPost.then(
        () => {
          blockedSettled = true;
        },
        () => {
          blockedSettled = true;
        },
      );

      // Wait for PostgreSQL to confirm that chain A's post really is stuck.
      await waitForBlockedBackends(watcher, 1);

      // Chain B must complete while that lock is still held. No timing
      // threshold is involved: the lock is released only after this resolves.
      const independentPost = await ledger.postMovement(command(independent, { quantityDelta: 7 }));
      expect(independentPost.quantityAfter).toBe(17);

      // And chain A is demonstrably still waiting at that moment.
      expect(blockedSettled).toBe(false);

      await holder.query('ROLLBACK');

      const releasedPost = await blockedPost;
      expect(releasedPost.quantityBefore).toBe(10);
      expect(releasedPost.quantityAfter).toBe(15);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      watcher.release();
      await blockedPost?.catch(() => undefined);
    }

    const blockedAudit = await auditChain(blocked);
    expect(blockedAudit.sumDelta).toBe(15);
    const independentAudit = await auditChain(independent);
    expect(independentAudit.sumDelta).toBe(17);
  });
});
