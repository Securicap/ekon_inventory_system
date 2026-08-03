import pg from 'pg';
import { loadConfig } from '../../src/config/index.js';
import { migrateUp } from '../../src/platform/db/migrator.js';
import { createPool, type DatabasePool } from '../../src/platform/db/pool.js';

/**
 * Integration tests run against real PostgreSQL, never a stub.
 *
 * The entire integrity model of this system is expressed in Postgres
 * constraints and triggers — append-only movements, the ledger chain, the
 * idempotency primary key. Testing that model against anything other than
 * Postgres proves nothing at all.
 *
 * Each suite creates a throwaway database, migrates it, and drops it.
 */

const ADMIN_DATABASE = 'postgres';

function parseUrl(url: string): { base: string; database: string } {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');
  parsed.pathname = '/';
  return { base: parsed.toString().replace(/\/$/, ''), database };
}

export interface TestDatabase {
  pool: DatabasePool;
  name: string;
  drop: () => Promise<void>;
}

/**
 * Creates a uniquely-named database, optionally migrates it, and returns a pool
 * connected to it. Call `drop()` in an `afterAll`.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const { migrate = true } = options;
  const config = loadConfig();
  const { base } = parseUrl(config.DATABASE_URL);

  const name = `ekon_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const admin = new pg.Client({ connectionString: `${base}/${ADMIN_DATABASE}` });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const pool = createPool({ ...config, DATABASE_URL: `${base}/${name}` });

  if (migrate) {
    await migrateUp(pool);
  }

  return {
    pool,
    name,
    drop: async () => {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: `${base}/${ADMIN_DATABASE}` });
      await cleanup.connect();
      try {
        await cleanup.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [name],
        );
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
