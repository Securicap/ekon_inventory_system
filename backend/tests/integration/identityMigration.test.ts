import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultMigrationsDir,
  migrateUp,
  migrationStatus,
} from '../../src/platform/db/migrator.js';
import { DEFAULT_ROLE_CAPABILITIES, ROLES } from '@ekon/shared';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0007 creates the identity data model: `users`, `sessions`, and
 * `role_capabilities`.
 *
 * These tests are about the *shape* of that schema — what exists, and just as
 * importantly what does not. The columns this migration refuses to create are
 * the point of it: an email address nobody has, an IP or user agent that would
 * turn a session row into a device registry, a capability snapshot that would
 * let a demoted user keep their old permissions. Constraint behaviour is
 * covered by `identityConstraints.test.ts`.
 */

const MIGRATIONS = defaultMigrationsDir();
const THROUGH_0006 = [
  '0001_extensions_and_conventions.sql',
  '0002_catalog.sql',
  '0003_variant_value_case_insensitivity.sql',
  '0004_inventory_locations.sql',
  '0005_inventory_ledger_core.sql',
  '0006_remove_movement_device_id.sql',
];
const M0007 = '0007_identity.sql';
const IDENTITY_TABLES = ['users', 'sessions', 'role_capabilities'];

const tempDirs: string[] = [];

/** Stages the given migration files into a fresh temp directory. */
async function stage(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0007-'));
  tempDirs.push(dir);
  for (const file of files) await copyFile(path.join(MIGRATIONS, file), path.join(dir, file));
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('migration 0007 — the identity schema', () => {
  let db: TestDatabase;
  let appliedBefore: { version: string; checksum: string; applied_at: Date }[];

  async function columnsOf(
    table: string,
  ): Promise<{ name: string; type: string; nullable: boolean }[]> {
    const { rows } = await db.pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY column_name`,
      [table],
    );
    return rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
    }));
  }

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stage(THROUGH_0006));

    const { rows } = await db.pool.query<{ version: string; checksum: string; applied_at: Date }>(
      `SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version`,
    );
    appliedBefore = rows;
    expect(appliedBefore.map((r) => r.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
    ]);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies on top of the existing migrations', async () => {
    expect(await migrateUp(db.pool, await stage([...THROUGH_0006, M0007]))).toEqual(['0007']);
  });

  it('creates exactly the three identity tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)
        ORDER BY table_name`,
      [IDENTITY_TABLES],
    );
    expect(rows.map((r) => r.table_name)).toEqual(['role_capabilities', 'sessions', 'users']);
  });

  it('does not create a separate roles or capabilities table', async () => {
    // Both vocabularies are closed sets in `@ekon/shared`, enforced by CHECK.
    // A lookup table would add a join and a second place for the same list to
    // be wrong.
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('roles', 'capabilities', 'user_capabilities', 'permissions')`,
    );
    expect(rows).toEqual([]);
  });

  it('gives users the expected columns and types', async () => {
    expect(await columnsOf('users')).toEqual([
      { name: 'created_at', type: 'timestamp with time zone', nullable: false },
      { name: 'display_name', type: 'text', nullable: false },
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'is_active', type: 'boolean', nullable: false },
      { name: 'password_hash', type: 'text', nullable: false },
      { name: 'role', type: 'text', nullable: false },
      { name: 'updated_at', type: 'timestamp with time zone', nullable: false },
      { name: 'username', type: 'text', nullable: false },
    ]);
  });

  it('generates no id or timestamp in the database', async () => {
    // Ids are UUIDv7 from application code so generation can move to the
    // browser without a schema change; timestamps come from the injected clock
    // so behaviour is testable. `is_active` is the one deliberate default.
    const { rows } = await db.pool.query<{ column_name: string; column_default: string }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1) AND column_default IS NOT NULL
        ORDER BY table_name, column_name`,
      [IDENTITY_TABLES],
    );
    expect(rows).toEqual([{ column_name: 'is_active', column_default: 'true' }]);
  });

  it('gives sessions the expected columns and types', async () => {
    expect(await columnsOf('sessions')).toEqual([
      { name: 'created_at', type: 'timestamp with time zone', nullable: false },
      { name: 'expires_at', type: 'timestamp with time zone', nullable: false },
      { name: 'id', type: 'uuid', nullable: false },
      // The only nullable column in the identity schema: a live session has not
      // been revoked.
      { name: 'revoked_at', type: 'timestamp with time zone', nullable: true },
      { name: 'token_hash', type: 'text', nullable: false },
      { name: 'user_id', type: 'uuid', nullable: false },
    ]);
  });

  it('gives role_capabilities two columns and a composite primary key', async () => {
    expect(await columnsOf('role_capabilities')).toEqual([
      { name: 'capability', type: 'text', nullable: false },
      { name: 'role', type: 'text', nullable: false },
    ]);

    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'role_capabilities'::regclass AND c.contype = 'p'
        ORDER BY k.ord`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['role', 'capability']);
  });

  it('stores no device, browser, network, or client identity on a session', async () => {
    // ADR 9: the permanent actor is the authenticated user. A session that
    // recorded which machine it came from would be a device registry by
    // accident, and technical request metadata belongs in security logging on
    // its own retention schedule.
    for (const column of [
      'device_id',
      'terminal_id',
      'browser_id',
      'client_id',
      'fingerprint',
      'ip_address',
      'ip',
      'user_agent',
      'last_seen_at',
      'last_activity_at',
      'refresh_token',
      'refresh_token_hash',
      'payload',
      'data',
      'capabilities',
      'token',
    ]) {
      const { rows } = await db.pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = $1`,
        [column],
      );
      expect(rows, `sessions.${column} should not exist`).toEqual([]);
    }
  });

  it('stores no email, PIN, recovery, or soft-delete column on a user', async () => {
    for (const column of [
      'email',
      'email_address',
      'email_verified_at',
      'pin',
      'pin_hash',
      'password',
      'password_hint',
      'security_question',
      'recovery_token',
      'reset_token',
      'deleted_at',
      'device_id',
      'last_login_ip',
    ]) {
      const { rows } = await db.pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users' AND column_name = $1`,
        [column],
      );
      expect(rows, `users.${column} should not exist`).toEqual([]);
    }
  });

  it('uses no json column anywhere in the identity schema', async () => {
    // Structured data goes in columns. A JSON blob is a schema nobody can
    // constrain, migrate, or index without finding out the hard way.
    const { rows } = await db.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)
          AND data_type IN ('json', 'jsonb')`,
      [IDENTITY_TABLES],
    );
    expect(rows).toEqual([]);
  });

  it('uses no native enum type', async () => {
    // Convention from 0001: text plus CHECK. Renaming or removing a value from
    // a native enum is painful in a way a CHECK is not.
    const { rows } = await db.pool.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = ANY($1)
          AND c.data_type = 'USER-DEFINED'`,
      [IDENTITY_TABLES],
    );
    expect(rows).toEqual([]);
  });

  it('points sessions at users with ON DELETE RESTRICT and indexes the key', async () => {
    // A user who has signed in cannot be deleted out from under their history;
    // they are deactivated (INV-12).
    const { rows } = await db.pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = 'sessions'::regclass AND contype = 'f'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confdeltype).toBe('r'); // RESTRICT

    const { rows: indexes } = await db.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'sessions' AND indexname = 'sessions_user_id_idx'`,
    );
    expect(indexes).toHaveLength(1);
  });

  it('adds no foreign key from inventory_movements to users', async () => {
    // Deliberately deferred. Existing movements carry arbitrary test actor
    // UUIDs, and the migration strategy for connecting permanent history to
    // real users is its own decision, made in the authentication series rather
    // than smuggled into the migration that first creates the table.
    const { rows } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'inventory_movements'::regclass
          AND contype = 'f' AND confrelid = 'users'::regclass`,
    );
    expect(rows).toEqual([]);
  });

  it('is a no-op when the migrator runs again', async () => {
    expect(await migrateUp(db.pool, await stage([...THROUGH_0006, M0007]))).toEqual([]);
  });

  it('leaves the previously applied migrations untouched', async () => {
    const { rows } = await db.pool.query<{ version: string; checksum: string; applied_at: Date }>(
      `SELECT version, checksum, applied_at FROM schema_migrations
        WHERE version <> '0007' ORDER BY version`,
    );
    expect(rows.map((r) => ({ version: r.version, checksum: r.checksum }))).toEqual(
      appliedBefore.map((r) => ({ version: r.version, checksum: r.checksum })),
    );
    // Not re-stamped either — a re-applied migration would move this.
    expect(rows.map((r) => r.applied_at.toISOString())).toEqual(
      appliedBefore.map((r) => r.applied_at.toISOString()),
    );
  });
});

describe('migration 0007 — transactionality', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stage(THROUGH_0006));
    // Something already occupies the name the migration wants. Whatever the
    // cause, the migration must fail as a unit rather than leaving two of its
    // three tables behind for the next run to trip over.
    await db.pool.query(`CREATE TABLE users (id uuid PRIMARY KEY)`);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('rolls back every statement when any one of them fails', async () => {
    await expect(migrateUp(db.pool, await stage([...THROUGH_0006, M0007]))).rejects.toThrow(
      /already exists/,
    );

    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('sessions', 'role_capabilities')`,
    );
    expect(rows).toEqual([]);

    // The pre-existing table is untouched, and 0007 was not recorded.
    const { rows: columns } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    expect(columns.map((r) => r.column_name)).toEqual(['id']);

    const applied = await db.pool.query(`SELECT 1 FROM schema_migrations WHERE version = '0007'`);
    expect(applied.rowCount).toBe(0);
  });
});

describe('migration 0007 on a clean database', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    // The path production takes on a new installation: an empty database
    // migrated straight to head.
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('reports 0007 as applied and unmodified, along with every other migration', async () => {
    const status = await migrationStatus(db.pool);
    // Found by version rather than taken from the end: later migrations have
    // landed since, and this suite is about 0007 rather than about head.
    expect(status.find((row) => row.version === '0007')).toMatchObject({
      filename: M0007,
      applied: true,
      checksumMatches: true,
    });
    for (const row of status) {
      expect(row.applied, `${row.filename} not applied`).toBe(true);
      expect(row.checksumMatches, `${row.filename} checksum drifted`).toBe(true);
    }
  });

  it('creates no user: a fresh installation has no credentials at all', async () => {
    // The first owner is created by `npm run identity:create-owner`. A default
    // account seeded by a migration is a password in source control that every
    // installation shares.
    const { rows } = await db.pool.query<{ count: number }>(`SELECT count(*) FROM users`);
    expect(rows[0]?.count).toBe(0);
  });

  it('seeds the role-capability table and nothing else', async () => {
    // Counted from the shared mapping rather than written out: 0007 opened the
    // table and later migrations grant into it, so a fixed number here would
    // become wrong every time the authorization model legitimately changed.
    // That the two sides agree grant for grant is asserted in
    // `identityConstraints.test.ts`.
    const { rows } = await db.pool.query<{ count: number }>(
      `SELECT count(*) FROM role_capabilities`,
    );
    const expected = ROLES.reduce(
      (total, role) => total + (DEFAULT_ROLE_CAPABILITIES[role] ?? []).length,
      0,
    );
    expect(rows[0]?.count).toBe(expected);

    const { rows: sessions } = await db.pool.query<{ count: number }>(
      `SELECT count(*) FROM sessions`,
    );
    expect(sessions[0]?.count).toBe(0);
  });
});
