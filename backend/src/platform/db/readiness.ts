import type { DatabasePool } from './pool.js';

/**
 * Waits for the database to answer, for a bounded time, and then gives up
 * loudly.
 *
 * The installed product is two services that start together. Windows brings up
 * Ekon and Ekon PostgreSQL at boot and gives no ordering guarantee worth
 * relying on; on the shop's hardware the database can spend twenty seconds
 * recovering before it opens its socket. An application that connected once and
 * exited would therefore be down every morning until somebody restarted it, and
 * nobody in the shop knows how — which would turn a normal cold start into a
 * support call.
 *
 * Bounded, though, and that is the other half. A service that retries forever
 * looks identical to a service that is working, from outside: no error, no
 * exit, nothing in a log anybody reads. A misconfigured `DATABASE_URL` would be
 * a process that sits there quietly all day. So there is a deadline, every
 * attempt is reported as it happens, and the failure at the end says how long
 * it waited and what the database actually said.
 */
export interface WaitForDatabaseOptions {
  /** How long to keep trying, in total, before failing. */
  timeoutMs: number;
  /** How long to wait between attempts. */
  intervalMs?: number;
  /** Where each retry is reported. The logger does not exist yet at this point. */
  log?: (message: string) => void;
}

const DEFAULT_INTERVAL_MS = 1_000;

/**
 * Resolves as soon as `SELECT 1` succeeds. Throws when the deadline passes.
 *
 * The first attempt is made immediately: a database that is already up costs
 * exactly one query, which is what this replaced.
 */
export async function waitForDatabase(
  pool: Pick<DatabasePool, 'query'>,
  options: WaitForDatabaseOptions,
): Promise<void> {
  const { timeoutMs } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? ((): void => {});

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) log(`Database is reachable after ${attempt} attempts.`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        throw new Error(
          `The database did not become reachable within ${timeoutMs} ms ` +
            `(${attempt} attempt(s)). Last error: ${reason}. ` +
            'Check that PostgreSQL is running and that DATABASE_URL names it correctly.',
        );
      }

      // Said every time rather than once. A start that takes forty seconds and
      // then works should leave a record of having done so: it is the earliest
      // warning that the database is getting slower to come up.
      log(`Database is not ready yet (attempt ${attempt}): ${reason}. Retrying.`);
      await sleep(Math.min(intervalMs, remaining));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
