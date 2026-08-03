import type { DatabaseClient, DatabasePool } from './pool.js';

/**
 * Runs `work` inside a single database transaction and hands it the client.
 *
 * Every state-changing command in this system commits exactly one transaction.
 * The inventory ledger depends on it: a movement insert, the balance update,
 * the operations row, and any audit event must all commit together or not at
 * all. There is no code path that writes inventory outside a unit of work.
 *
 * Nested calls are not supported by design — if you find yourself wanting one,
 * the transaction boundary is in the wrong place.
 */
export async function withTransaction<T>(
  pool: DatabasePool,
  work: (tx: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it below discards it.
    }
    throw error;
  } finally {
    client.release();
  }
}
