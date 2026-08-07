import { expect } from 'vitest';
import type { DatabaseClient, DatabasePool } from '../../src/platform/db/pool.js';

/**
 * Forcing two commands to genuinely overlap, and knowing that they did.
 *
 * `Promise.all` alone proves nothing about concurrency: the calls might simply
 * run one after another and pass for the wrong reason. So a scenario that
 * claims to be a race has to make one, and has to be able to fail when it does
 * not happen.
 *
 * The shape here is: a separate transaction takes the contended lock first, the
 * commands are launched, and the test waits until PostgreSQL itself reports
 * that all of them are blocked on a lock — read from `pg_stat_activity`, not
 * guessed at with a sleep — before releasing them. If the overlap never
 * happens, the barrier times out and the test fails rather than passing
 * quietly.
 *
 * Shared by the posting engine's concurrency suite, which drives the ledger
 * service directly, and by the removal suite, which drives the same lock
 * through HTTP. Both contend for the same thing — the `inventory_balances` row
 * — so both stage it the same way, and a second hand-written copy of this
 * barrier would be a second thing to get subtly wrong.
 */

/** Bounded safety guard on the barrier. Reached only when overlap never happens. */
const BLOCKED_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A (variant, location) movement chain — the unit the balance lock protects. */
export interface LockableChain {
  variantId: string;
  locationId: string;
}

/**
 * Waits until PostgreSQL reports `expected` backends blocked on a lock in this
 * test database. This is the barrier: it is the database confirming that the
 * commands really are contending, rather than the test hoping they are.
 */
export async function waitForBlockedBackends(
  watcher: DatabaseClient,
  expected: number,
): Promise<void> {
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
 * Runs `attempts` concurrently with guaranteed overlap.
 *
 * `takeBlock` runs first, in its own transaction, and takes whatever lock the
 * attempts will contend for. Every attempt is then launched, the barrier waits
 * until all of them are blocked, and only then is the blocking transaction
 * rolled back — releasing them into a genuine race.
 *
 * Results come back as `PromiseSettledResult`s because in most of these
 * scenarios one attempt is *supposed* to fail, and which one is never assumed.
 */
export async function runConcurrentlyBehindLock<T>(
  pool: DatabasePool,
  takeBlock: (holder: DatabaseClient) => Promise<void>,
  attempts: Array<() => Promise<T>>,
): Promise<PromiseSettledResult<T>[]> {
  const watcher = await pool.connect();
  const holder = await pool.connect();

  try {
    await holder.query('BEGIN');
    await takeBlock(holder);

    const running = attempts.map((attempt) => attempt());
    // Keep an early rejection from surfacing as an unhandled rejection while
    // the barrier is still waiting; `running` itself is still settled below.
    for (const promise of running) promise.catch(() => undefined);

    await waitForBlockedBackends(watcher, attempts.length);
    await holder.query('ROLLBACK');

    return await Promise.allSettled(running);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    watcher.release();
  }
}

/** Locks an existing balance row, so posts to that chain queue behind it. */
export const lockBalanceRow =
  (chain: LockableChain) =>
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
export const holdPendingBalanceInsert =
  (chain: LockableChain, updatedAt: Date) =>
  async (holder: DatabaseClient): Promise<void> => {
    await holder.query(
      `INSERT INTO inventory_balances
         (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
       VALUES ($1, $2, 0, NULL, $3)`,
      [chain.variantId, chain.locationId, updatedAt],
    );
  };

export function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

export function rejections<T>(results: PromiseSettledResult<T>[]): unknown[] {
  return results.filter((r) => r.status === 'rejected').map((r) => r.reason);
}
