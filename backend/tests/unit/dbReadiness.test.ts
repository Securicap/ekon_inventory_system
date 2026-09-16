import { describe, expect, it, vi } from 'vitest';
import { waitForDatabase } from '../../src/platform/db/readiness.js';

/**
 * Starting while PostgreSQL is still coming up.
 *
 * The installed product is two Windows services that start together, and the
 * shop turns the computer on and walks to the counter. Whichever service is
 * ready first has to wait for the other, or Ekon is down every morning until
 * somebody restarts it — and nobody on site knows how.
 *
 * Bounded, though: a service that retried forever would look exactly like one
 * that is working, from outside.
 */

/** A pool that refuses `failures` times and then answers. */
function poolThatFailsTimes(failures: number, reason = 'ECONNREFUSED 127.0.0.1:5432') {
  let attempts = 0;
  return {
    attempts: () => attempts,
    query: vi.fn(async () => {
      attempts += 1;
      if (attempts <= failures) throw new Error(reason);
      return { rows: [] } as never;
    }),
  };
}

describe('waitForDatabase', () => {
  it('costs exactly one query when the database is already up', async () => {
    const pool = poolThatFailsTimes(0);
    await waitForDatabase(pool, { timeoutMs: 1000, intervalMs: 1 });
    expect(pool.attempts()).toBe(1);
  });

  it('keeps trying until the database answers', async () => {
    const pool = poolThatFailsTimes(3);
    await waitForDatabase(pool, { timeoutMs: 2000, intervalMs: 1 });
    expect(pool.attempts()).toBe(4);
  });

  it('reports every retry, so a start that took a minute leaves a record', async () => {
    // Said every time rather than once: it is the earliest warning that the
    // database is getting slower to come up.
    const pool = poolThatFailsTimes(2);
    const lines: string[] = [];
    await waitForDatabase(pool, { timeoutMs: 2000, intervalMs: 1, log: (m) => lines.push(m) });

    const retries = lines.filter((line) => line.includes('not ready'));
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatch(/attempt 1/);
    // The reason the database gave, not a generic "waiting…".
    expect(retries[0]).toMatch(/ECONNREFUSED/);
    expect(lines.at(-1)).toMatch(/reachable after 3 attempts/);
  });

  it('gives up at the deadline, and says what the database said', async () => {
    const pool = poolThatFailsTimes(Number.MAX_SAFE_INTEGER, 'password authentication failed');
    await expect(waitForDatabase(pool, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(
      /did not become reachable within 20 ms[\s\S]*password authentication failed/,
    );
  });

  it('names DATABASE_URL in the failure, because that is usually what is wrong', async () => {
    const pool = poolThatFailsTimes(Number.MAX_SAFE_INTEGER);
    await expect(waitForDatabase(pool, { timeoutMs: 5, intervalMs: 1 })).rejects.toThrow(
      /DATABASE_URL/,
    );
  });

  it('tries once even when told to wait for no time at all', async () => {
    // `DATABASE_WAIT_TIMEOUT_MS=0` means "do not wait", not "do not look".
    const pool = poolThatFailsTimes(0);
    await waitForDatabase(pool, { timeoutMs: 0, intervalMs: 1 });
    expect(pool.attempts()).toBe(1);
  });

  it('fails immediately with no timeout rather than retrying once anyway', async () => {
    const pool = poolThatFailsTimes(1);
    await expect(waitForDatabase(pool, { timeoutMs: 0, intervalMs: 1 })).rejects.toThrow();
    expect(pool.attempts()).toBe(1);
  });
});
