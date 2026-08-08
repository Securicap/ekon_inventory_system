import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSchemaVersion,
  currentSchemaVersion,
  loadMigrations,
  migrateUp,
  migrationStatus,
} from '../../src/platform/db/migrator.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

describe('migration runner', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('migrates an empty database to head', async () => {
    const applied = await migrateUp(db.pool);
    expect(applied.length).toBeGreaterThan(0);

    const files = await loadMigrations();
    expect(await currentSchemaVersion(db.pool)).toBe(files.at(-1)?.version);
  });

  it('is a no-op when run again', async () => {
    // Deploys re-run migrations on every release. A second run must apply
    // nothing rather than failing or duplicating work.
    expect(await migrateUp(db.pool)).toEqual([]);
  });

  it('reports every migration as applied with a matching checksum', async () => {
    const status = await migrationStatus(db.pool);
    expect(status.length).toBeGreaterThan(0);
    for (const row of status) {
      expect(row.applied, `${row.filename} not applied`).toBe(true);
      expect(row.checksumMatches, `${row.filename} checksum drifted`).toBe(true);
    }
  });

  it('installs the extensions the schema depends on', async () => {
    const { rows } = await db.pool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pgcrypto')`,
    );
    expect(rows.map((r) => r.extname).sort()).toEqual(['citext', 'pgcrypto']);
  });

  /**
   * The other half of the production pin. `loadConfig` guarantees a production
   * deploy supplies `EXPECTED_SCHEMA_VERSION` at all
   * (`tests/unit/config.test.ts`); this is what `main.ts` does with the value
   * once it has one, and the reason the pin is worth requiring.
   */
  it('accepts a pin matching the version the database is at', async () => {
    const head = (await loadMigrations()).at(-1)?.version;
    if (!head) throw new Error('No migrations found; cannot determine the head version');
    await expect(assertSchemaVersion(db.pool, head)).resolves.toBeUndefined();
  });

  it('refuses a pin the database does not match', async () => {
    await expect(assertSchemaVersion(db.pool, '9998')).rejects.toThrow(/Schema version mismatch/);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    // Editing a migration that has already run in production is how
    // environments silently diverge. It must be a hard error.
    await db.pool.query(
      `UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0001'`,
    );
    await expect(migrateUp(db.pool)).rejects.toThrow(/has changed since it was applied/);
    // Restore so later assertions in this file are unaffected.
    const files = await loadMigrations();
    await db.pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0001'`, [
      files[0]?.checksum,
    ]);
  });

  it('refuses to run when the database is ahead of the checkout', async () => {
    await db.pool.query(
      `INSERT INTO schema_migrations (version, filename, checksum) VALUES ('9999', '9999_from_the_future.sql', 'x')`,
    );
    await expect(migrateUp(db.pool)).rejects.toThrow(/code is older than the database/);
    await db.pool.query(`DELETE FROM schema_migrations WHERE version = '9999'`);
  });

  it('rolls the whole migration back when its sql fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ekon-mig-'));
    try {
      await writeFile(
        path.join(dir, '0001_partly_valid.sql'),
        'CREATE TABLE should_not_survive (id int);\nTHIS IS NOT SQL;\n',
      );
      const fresh = await createTestDatabase({ migrate: false });
      try {
        await expect(migrateUp(fresh.pool, dir)).rejects.toThrow(/failed and was rolled back/);
        const { rows } = await fresh.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name = 'should_not_survive'`,
        );
        expect(rows[0]?.count).toBe('0');
      } finally {
        await fresh.drop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a badly named migration file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ekon-mig-'));
    try {
      await writeFile(path.join(dir, 'add-users.sql'), 'SELECT 1;');
      await expect(loadMigrations(dir)).rejects.toThrow(/is invalid/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
