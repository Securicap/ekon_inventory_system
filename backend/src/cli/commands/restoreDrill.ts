import path from 'node:path';
import type pg from 'pg';
import type { Config } from '../../config/index.js';
import {
  createDatabase,
  dropDatabaseIfExists,
  withAdminClient,
  withDatabaseClient,
} from '../adminDb.js';
import { verifyBackupFile } from '../backup/integrity.js';
import { databaseNameFromUrl, runPgTool } from '../pgTools.js';

/**
 * Prove a backup can be restored — into a throwaway database that is destroyed
 * afterwards, never into anything a shop is using.
 *
 * An untested backup is not a backup. This is the test, it is meant to run on a
 * schedule, and ADR 13 makes it a release requirement: an installation is not
 * fit to hold real inventory until a restore has been performed from a copy
 * that left the machine.
 *
 * What it will not do, by construction:
 *
 *   - it never writes to the live database. It creates
 *     `ekon_restore_drill` and only ever addresses that name;
 *   - it never leaves the drill database behind, even when it fails — the drop
 *     is in a `finally`;
 *   - it refuses a file from outside the backup directory unless told
 *     explicitly, so a drill cannot be pointed at something a caller downloaded.
 *
 * The one thing it shares with production is the **cluster**, and that is a
 * deliberate trade. The archived OCI script started a disposable PostgreSQL
 * container, which proved more and cost a Docker daemon; the shop computer has
 * no Docker and a second PostgreSQL would be a second thing to install and keep
 * at the right version. Restoring into the same server the backup came from is
 * also the more honest test of the question that actually matters: *will this
 * archive restore into this installation.*
 */

export const DRILL_DATABASE = 'ekon_restore_drill';

export interface RestoreDrillOptions {
  /** Permit a file outside `EKON_BACKUP_DIR`. */
  allowExternal?: boolean | undefined;
}

/** The tables a database has to have before it is an Ekon database at all. */
const CORE_TABLES = [
  'users',
  'sessions',
  'role_capabilities',
  'products',
  'product_variants',
  'variant_attributes',
  'inventory_locations',
  'inventory_movements',
  'inventory_balances',
  'inventory_count_lines',
  'operations',
  'schema_migrations',
] as const;

export async function runRestoreDrill(
  config: Config,
  file: string,
  options: RestoreDrillOptions,
  log: (message: string) => void,
): Promise<void> {
  const dumpPath = path.resolve(file);
  assertInsideBackupDir(dumpPath, config.EKON_BACKUP_DIR, options.allowExternal ?? false);

  if (databaseNameFromUrl(config.DATABASE_URL) === DRILL_DATABASE) {
    throw new Error(
      `DATABASE_URL names ${DRILL_DATABASE}, which is the drill's own scratch database. ` +
        'Refusing: the drill would be restoring over the thing it is meant to protect.',
    );
  }

  log(`Verifying ${dumpPath}`);
  const verified = await verifyBackupFile(dumpPath);
  log(
    verified.checksumVerified
      ? `  sha256 matches the sidecar (${verified.sha256})`
      : `  sha256 ${verified.sha256} — no sidecar beside the dump, integrity is unproven`,
  );

  const failures: string[] = [];
  const pass = (what: string): void => log(`  PASS  ${what}`);
  const fail = (what: string): void => {
    failures.push(what);
    log(`  FAIL  ${what}`);
  };

  await withAdminClient(config.DATABASE_URL, async (admin) => {
    // Dropped first, not reused. A drill that ran against leftovers from the
    // last one would pass on data this archive does not contain.
    await dropDatabaseIfExists(admin, DRILL_DATABASE);
    await createDatabase(admin, DRILL_DATABASE);
  });

  try {
    log(`Restoring into ${DRILL_DATABASE}`);
    // `--exit-on-error` so a partial restore is a failure rather than a
    // database that looks plausible. `--no-owner --no-privileges` because the
    // dump was taken that way and the roles on this cluster are not the dump's.
    await runPgTool(
      'pg_restore',
      ['--dbname', DRILL_DATABASE, '--no-owner', '--no-privileges', '--exit-on-error', dumpPath],
      { databaseUrl: config.DATABASE_URL, pgBin: config.EKON_PG_BIN, log },
    );
    pass('pg_restore completed without error');

    await withDatabaseClient(config.DATABASE_URL, DRILL_DATABASE, async (client) => {
      await checkSchemaHead(client, pass, fail, log);
      await checkCoreTables(client, pass, fail);
      await checkContents(client, pass, fail, log);
    });
  } catch (error) {
    fail(`pg_restore or the checks failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    // Always. A drill that left its database behind would fill the disk one
    // night a week, and the next drill would refuse to create it.
    await withAdminClient(config.DATABASE_URL, (admin) =>
      dropDatabaseIfExists(admin, DRILL_DATABASE),
    ).catch((error: unknown) => {
      log(
        `Warning: could not drop ${DRILL_DATABASE}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  if (failures.length > 0) {
    throw new Error(
      `RESTORE DRILL FAILED — ${failures.length} check(s) did not pass:\n` +
        failures.map((what) => `  - ${what}`).join('\n') +
        '\nDo not rely on this backup.',
    );
  }

  log('RESTORE DRILL PASSED. This backup restores into a working Ekon database.');
}

async function checkSchemaHead(
  client: pg.Client,
  pass: (what: string) => void,
  fail: (what: string) => void,
  log: (message: string) => void,
): Promise<void> {
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  const head = rows[0]?.version;

  if (head === undefined) {
    fail('schema_migrations is missing or empty — this is not an Ekon database');
    return;
  }
  pass(`schema_migrations head is ${head}`);

  // Reported, never failed. A backup older than the current release is
  // legitimately behind, and migrations would run on restore. What matters is
  // that the restored database has a coherent version at all.
  log(`  NOTE  restored schema is ${head}`);
}

async function checkCoreTables(
  client: pg.Client,
  pass: (what: string) => void,
  fail: (what: string) => void,
): Promise<void> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const present = new Set(rows.map((row) => row.table_name));

  const missing = CORE_TABLES.filter((table) => !present.has(table));
  if (missing.length === 0) pass(`all ${CORE_TABLES.length} core tables are present`);
  else fail(`missing table(s): ${missing.join(', ')}`);
}

/**
 * Read-only sanity, on the restored copy.
 *
 * Counts and one invariant. A drill that wrote to the restored database would
 * be testing something nobody asked about and would make its own numbers
 * meaningless.
 */
async function checkContents(
  client: pg.Client,
  pass: (what: string) => void,
  fail: (what: string) => void,
  log: (message: string) => void,
): Promise<void> {
  const counts = await client.query<{
    users: number;
    products: number;
    movements: number;
    balances: number;
  }>(`
    SELECT (SELECT count(*) FROM users)                AS users,
           (SELECT count(*) FROM products)             AS products,
           (SELECT count(*) FROM inventory_movements)  AS movements,
           (SELECT count(*) FROM inventory_balances)   AS balances
  `);
  const row = counts.rows[0];
  if (!row) {
    fail('could not read the restored database');
    return;
  }
  log(
    `  users ${row.users} · products ${row.products} · movements ${row.movements} · ` +
      `balance rows ${row.balances}`,
  );
  pass('inventory_movements is queryable');

  // Somebody has to be able to sign in to a restored system, or it is a
  // database rather than a working installation.
  const owners = await client.query<{ count: number }>(
    `SELECT count(*) AS count FROM users WHERE role = 'OWNER' AND is_active`,
  );
  const activeOwners = owners.rows[0]?.count ?? 0;
  if (activeOwners >= 1) pass(`restored database has ${activeOwners} active owner(s)`);
  else fail('restored database has no active owner — nobody could sign in to it');

  // The ledger's own invariant, checked against the restored copy: a balance is
  // a projection of movements (INV-6), so a balance row with no movement behind
  // it would mean the dump caught the two out of step.
  const orphans = await client.query<{ count: number }>(`
    SELECT count(*) AS count
      FROM inventory_balances b
     WHERE NOT EXISTS (
       SELECT 1 FROM inventory_movements m
        WHERE m.variant_id = b.variant_id AND m.location_id = b.location_id
     )
  `);
  const orphanCount = orphans.rows[0]?.count ?? 0;
  if (orphanCount === 0) pass('every balance row has movements behind it');
  else fail(`${orphanCount} balance row(s) with no matching movements`);
}

/**
 * Refuses a dump from outside the backup directory.
 *
 * The drill drops and recreates a database and runs a restore; pointing it at
 * an arbitrary file is how that capability gets borrowed for something else.
 * `--allow-external` is the deliberate way to restore from a drive somebody
 * carried in, which is exactly the copy ADR 13 says has to be tested.
 */
export function assertInsideBackupDir(
  dumpPath: string,
  backupDir: string | undefined,
  allowExternal: boolean,
): void {
  if (allowExternal) return;

  const directory = backupDir?.trim();
  if (directory === undefined || directory === '') {
    throw new Error(
      'EKON_BACKUP_DIR is not set, so there is no directory this file could be inside. ' +
        'Pass --allow-external to use a dump from somewhere else.',
    );
  }

  const resolved = path.resolve(directory);
  const relative = path.relative(resolved, dumpPath);
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);

  if (!inside) {
    throw new Error(
      `${dumpPath} is not under EKON_BACKUP_DIR (${resolved}). ` +
        'Pass --allow-external if that is deliberate — a copy from a drive, for example.',
    );
  }
}
