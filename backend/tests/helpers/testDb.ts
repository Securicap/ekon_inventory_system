import pg from 'pg';
import { loadConfig } from '../../src/config/index.js';
import { migrateUp } from '../../src/platform/db/migrator.js';
import { createPool, type DatabasePool } from '../../src/platform/db/pool.js';

/**
 * Integration tests run against real PostgreSQL, never a stub.
 *
 * The entire integrity model of this system is expressed in Postgres
 * constraints and triggers — append-only movements, the ledger chain, the
 * idempotency primary key, and since 0014 the privileges of the role the
 * application connects as. Testing that model against anything other than
 * Postgres proves nothing at all.
 *
 * Each suite creates a throwaway database, migrates it, and drops it.
 *
 * **Two connections, deliberately.**
 *
 * `pool` is the **admin** connection — the role that owns the tables. It
 * creates the database, applies the migrations, and is what test setup writes
 * fixtures through. It is also what a test asserting a *database* guarantee
 * must use: an `UPDATE inventory_movements` refused by the append-only trigger
 * and one refused by a missing grant fail with different SQLSTATEs, and a test
 * of the trigger should be testing the trigger.
 *
 * `appPool` is the **restricted** connection — a login user in `ekon_app`,
 * exactly as an installation is configured (0014). Every test that builds the
 * application passes this one, so the whole HTTP surface is exercised under the
 * privileges production actually runs with. That is the point: a code path that
 * needs a grant nobody granted fails here, in CI, rather than at a counter.
 */

const ADMIN_DATABASE = 'postgres';

/**
 * The restricted login user, and its password.
 *
 * Development and CI create it (`make db-app-user`, and a step in the
 * workflow); `ensureRuntimeRole` below creates it too, because a developer's
 * database volume may predate 0014 and Docker only runs an init script when it
 * creates the data directory. None of that is a credential worth protecting: it
 * is a local development password, in a container bound to a developer's own
 * machine, and an installation generates its own.
 */
const RUNTIME_USER = 'ekon_runtime';
const RUNTIME_PASSWORD = 'ekon_runtime';

function parseUrl(url: string): { base: string; database: string } {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');
  parsed.pathname = '/';
  return { base: parsed.toString().replace(/\/$/, ''), database };
}

/** The same cluster, as the restricted application user. */
function runtimeUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.username = RUNTIME_USER;
  url.password = RUNTIME_PASSWORD;
  url.pathname = `/${database}`;
  return url.toString();
}

export interface TestDatabase {
  /**
   * The owning role: migrations, fixtures, and any test whose subject is a
   * constraint or a trigger rather than an application code path.
   */
  pool: DatabasePool;
  /**
   * What the application connects as — a member of `ekon_app`, with no more
   * privilege than an installation grants. Pass this to `buildApp`.
   */
  appPool: DatabasePool;
  name: string;
  drop: () => Promise<void>;
}

/**
 * Creates a uniquely-named database, optionally migrates it, and returns both
 * pools. Call `drop()` in an `afterAll`.
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
    // Migrations run as the owner, exactly as they do on an installation: 0014
    // creates `ekon_app` and grants it what the application needs, and no
    // application role could have applied it.
    await migrateUp(pool);
    await ensureRuntimeRole(`${base}/${name}`);
  }

  const appPool = createPool({
    ...config,
    DATABASE_URL: migrate ? runtimeUrl(`${base}/${name}`, name) : `${base}/${name}`,
  });

  return {
    pool,
    appPool,
    name,
    drop: async () => {
      await Promise.all([pool.end(), appPool.end()]);
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

/**
 * Makes sure the restricted login user exists and is in `ekon_app`.
 *
 * Roles are cluster-wide, so this is a no-op after the first test database of a
 * run — but it cannot be skipped altogether. Migration 0014 deliberately does
 * not create a login user (a migration is committed to a public repository and
 * a password is not), and Docker only runs `initdb` scripts when it creates the
 * data directory, so a developer whose volume predates 0014 has no such role.
 * Running the statement here means `npm test` works on a checkout without a
 * `make db-reset` first.
 *
 * The membership has to be granted per database connection rather than at
 * creation, because `ekon_app` does not exist until 0014 has run.
 */
async function ensureRuntimeRole(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_USER}') THEN
          CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD '${RUNTIME_PASSWORD}';
        END IF;
        GRANT ekon_app TO ${RUNTIME_USER};
      END
      $$;
    `);
  } finally {
    await client.end();
  }
}
