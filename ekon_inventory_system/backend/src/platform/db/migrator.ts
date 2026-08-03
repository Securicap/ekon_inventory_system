import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabasePool } from './pool.js';

/**
 * A deliberately small migration runner.
 *
 * Migrations are plain `.sql` files, committed to the repository, applied in
 * filename order, each inside its own transaction. There is no down-migration
 * mechanism: reversing a schema change in production is done by writing a new
 * forward migration, which is reviewable and leaves a record. A `down` that
 * nobody has ever run is not a safety net.
 *
 * Applied migrations are checksummed. Editing a file that has already run is a
 * hard error rather than a silent divergence between environments.
 */

const MIGRATIONS_TABLE = 'schema_migrations';
const FILENAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  version: string;
  filename: string;
  applied: boolean;
  appliedAt: Date | null;
  checksumMatches: boolean | null;
}

export function defaultMigrationsDir(): string {
  // src/platform/db -> backend/migrations (and dist/platform/db -> backend/migrations)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');
}

function checksum(sql: string): string {
  // Normalize line endings so a Windows checkout does not invalidate every
  // migration that has already been applied on Linux.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function loadMigrations(dir = defaultMigrationsDir()): Promise<Migration[]> {
  const entries = await readdir(dir);
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();

  const migrations: Migration[] = [];
  for (const filename of sqlFiles) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match?.[1]) {
      throw new Error(
        `Migration filename "${filename}" is invalid. ` +
          'Expected NNNN_lower_snake_case.sql, for example 0002_identity.sql',
      );
    }
    const version = match[1];
    if (migrations.some((m) => m.version === version)) {
      throw new Error(`Duplicate migration version ${version} in ${dir}`);
    }
    const sql = await readFile(path.join(dir, filename), 'utf8');
    migrations.push({ version, filename, sql, checksum: checksum(sql) });
  }

  return migrations;
}

async function ensureMigrationsTable(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    text        PRIMARY KEY,
      filename   text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

interface AppliedRow {
  version: string;
  filename: string;
  checksum: string;
  applied_at: Date;
}

async function fetchApplied(pool: DatabasePool): Promise<Map<string, AppliedRow>> {
  const { rows } = await pool.query<AppliedRow>(
    `SELECT version, filename, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  return new Map(rows.map((row) => [row.version, row]));
}

/** Applies every pending migration. Returns the versions that were applied. */
export async function migrateUp(
  pool: DatabasePool,
  dir = defaultMigrationsDir(),
  log: (message: string) => void = () => {},
): Promise<string[]> {
  await ensureMigrationsTable(pool);

  const migrations = await loadMigrations(dir);
  const applied = await fetchApplied(pool);

  for (const [version, row] of applied) {
    const known = migrations.find((m) => m.version === version);
    if (!known) {
      throw new Error(
        `Database has migration ${version} (${row.filename}) applied, but no such file exists ` +
          'in this checkout. The code is older than the database — deploy the right revision.',
      );
    }
    if (known.checksum !== row.checksum) {
      throw new Error(
        `Migration ${version} (${known.filename}) has changed since it was applied on ` +
          `${row.applied_at.toISOString()}. Applied migrations are immutable — write a new ` +
          'migration instead of editing this one.',
      );
    }
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    log('No pending migrations.');
    return [];
  }

  const appliedNow: string[] = [];
  for (const migration of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, filename, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.filename, migration.checksum],
      );
      await client.query('COMMIT');
      appliedNow.push(migration.version);
      log(`Applied ${migration.filename}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(
        `Migration ${migration.filename} failed and was rolled back: ${(error as Error).message}`,
      );
    } finally {
      client.release();
    }
  }

  return appliedNow;
}

export async function migrationStatus(
  pool: DatabasePool,
  dir = defaultMigrationsDir(),
): Promise<MigrationStatus[]> {
  await ensureMigrationsTable(pool);
  const migrations = await loadMigrations(dir);
  const applied = await fetchApplied(pool);

  return migrations.map((migration) => {
    const row = applied.get(migration.version);
    return {
      version: migration.version,
      filename: migration.filename,
      applied: row !== undefined,
      appliedAt: row?.applied_at ?? null,
      checksumMatches: row ? row.checksum === migration.checksum : null,
    };
  });
}

/** Highest applied migration version, or null on an empty database. */
export async function currentSchemaVersion(pool: DatabasePool): Promise<string | null> {
  const { rows } = await pool.query<{ version: string }>(
    `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version DESC LIMIT 1`,
  );
  return rows[0]?.version ?? null;
}

/**
 * Refuses to continue if the database is not at the version this build expects.
 * Called at boot so a half-deployed environment fails loudly instead of serving
 * requests against a schema it does not understand.
 */
export async function assertSchemaVersion(pool: DatabasePool, expected: string): Promise<void> {
  const actual = await currentSchemaVersion(pool);
  if (actual !== expected) {
    throw new Error(
      `Schema version mismatch: this build expects ${expected}, database is at ${actual ?? 'none'}. ` +
        'Run migrations before starting the application.',
    );
  }
}
