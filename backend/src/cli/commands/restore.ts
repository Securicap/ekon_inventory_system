import path from 'node:path';
import type { Config } from '../../config/index.js';
import { migrateUp } from '../../platform/db/migrator.js';
import { createPool } from '../../platform/db/pool.js';
import {
  createDatabase,
  databaseExists,
  dropDatabaseIfExists,
  renameDatabase,
  withAdminClient,
} from '../adminDb.js';
import { verifyBackupFile } from '../backup/integrity.js';
import { backupStamp, isPreRestoreDatabaseName, preRestoreDatabaseName } from '../backup/naming.js';
import { databaseNameFromUrl, runPgTool, withDatabase } from '../pgTools.js';
import { assertInsideBackupDir } from './restoreDrill.js';

/**
 * Put a backup back, into the database the shop actually uses.
 *
 * This is the most dangerous command in the product, and the shape of it is an
 * answer to that rather than an apology for it.
 *
 * **Nothing is destroyed.** The live database is *renamed*, not dropped:
 * `ekon` becomes `ekon_pre_restore_20260915T031500Z` and stays on the cluster,
 * complete, until somebody deliberately names it to `--discard-previous`. An
 * operator who restores the wrong archive at four in the morning has made a
 * reversible mistake, which is the only kind worth designing for. Disk is
 * cheaper than a shop's records by every measure that matters.
 *
 * **It refuses to run by accident.** `--yes` is required: a restore is a
 * decision, and the archived OCI runbook deliberately had no
 * `restore-production.sh` for exactly this reason. What has changed is that the
 * shop computer has no operator with a runbook standing next to it, so the
 * command exists — and states what it is about to do, and demands that the
 * caller has said so.
 *
 * **Migrations run afterwards.** A backup may predate the installed build
 * (ADR 13, point 7: upgrades migrate in place and never ask a shop to re-enter
 * anything), so the restored database is brought up to the schema this build
 * expects before anybody is told it is ready.
 */

export interface RestoreOptions {
  yes?: boolean | undefined;
  allowExternal?: boolean | undefined;
  /** The name of a database displaced by an *earlier* restore, to drop. */
  discardPrevious?: string | undefined;
  now?: Date | undefined;
}

export async function runRestore(
  config: Config,
  file: string,
  options: RestoreOptions,
  log: (message: string) => void,
): Promise<void> {
  const dumpPath = path.resolve(file);
  const live = databaseNameFromUrl(config.DATABASE_URL);
  const displaced = preRestoreDatabaseName(backupStamp(options.now ?? new Date()));

  assertInsideBackupDir(dumpPath, config.EKON_BACKUP_DIR, options.allowExternal ?? false);

  if (options.yes !== true) {
    throw new Error(
      `Refusing to restore without --yes.\n\n` +
        `  This would replace the contents of the database "${live}" with ${dumpPath}.\n` +
        `  The current database would be kept, renamed to "${displaced}", and nothing\n` +
        `  would be deleted — but every change made since that backup was taken would\n` +
        `  stop being what Ekon serves.\n\n` +
        `  Stop the Ekon service first, then run the same command with --yes.`,
    );
  }

  // Every refusal happens before anything is touched, and that ordering is the
  // point: a `--discard-previous` that names the wrong thing must not be
  // discovered after the live database has already been renamed.
  if (options.discardPrevious !== undefined) {
    assertDiscardable(options.discardPrevious, displaced);
  }

  // Discovering that an archive is corrupt *after* renaming the live database
  // would leave an installation with no database at the name the service
  // connects to.
  log(`Verifying ${dumpPath}`);
  const verified = await verifyBackupFile(dumpPath);
  log(
    verified.checksumVerified
      ? `  sha256 matches the sidecar (${verified.sha256})`
      : `  sha256 ${verified.sha256} — no sidecar beside the dump, integrity is unproven`,
  );

  await withAdminClient(config.DATABASE_URL, async (admin) => {
    if (await databaseExists(admin, displaced)) {
      throw new Error(
        `${displaced} already exists on this cluster. A restore in the same second has ` +
          'already displaced a database; rename or discard it before running another.',
      );
    }

    log(`Renaming "${live}" to "${displaced}"`);
    // Every other connection is closed first — the Ekon service holds a pool,
    // and a rename fails while anything is attached. The runbook says to stop
    // the service; this makes the command work even when somebody did not.
    await renameDatabase(admin, live, displaced);

    log(`Creating a fresh "${live}"`);
    await createDatabase(admin, live);
  });

  log(`Restoring ${path.basename(dumpPath)} into "${live}"`);
  await runPgTool(
    'pg_restore',
    ['--dbname', live, '--no-owner', '--no-privileges', '--exit-on-error', dumpPath],
    { databaseUrl: config.DATABASE_URL, pgBin: config.EKON_PG_BIN, log },
  );

  log('Applying any migrations the backup predates');
  const pool = createPool({ ...config, DATABASE_URL: withDatabase(config.DATABASE_URL, live) });
  try {
    const applied = await migrateUp(pool, undefined, (message) => log(`  ${message}`));
    log(applied.length === 0 ? '  Database is up to date.' : `  Applied ${applied.length}.`);
  } finally {
    await pool.end();
  }

  if (options.discardPrevious !== undefined) {
    await discard(config, options.discardPrevious, log);
  }

  log('');
  log('Restore complete. Next steps:');
  log(`  1. Start the Ekon service and sign in.`);
  log(`  2. Check the most recent movements are the ones you expect.`);
  log(`  3. The database this replaced is kept as "${displaced}".`);
  log(`     Drop it, once you are sure, with:`);
  log(`       ekon-ctl restore <file> --yes --discard-previous ${displaced}`);
  log(`     or by hand. Nothing removes it on its own.`);
}

/**
 * The three refusals that stand between `--discard-previous` and a database
 * nobody meant to drop. Checked before this command touches anything.
 *
 *   - it must be named explicitly, so no run of this command drops anything the
 *     caller did not type — that is the flag's existence, not this function;
 *   - the name must look like one this tool produced, so a typo cannot land on
 *     the live database or on something else entirely;
 *   - it must not be the one *this* run is about to create, which is the copy
 *     the operator will want if the restore turns out to be wrong.
 */
function assertDiscardable(name: string, aboutToDisplace: string): void {
  if (!isPreRestoreDatabaseName(name)) {
    throw new Error(
      `--discard-previous "${name}" is not the name of a database a restore displaced. ` +
        'Those are named ekon_pre_restore_<UTC stamp>, and nothing else may be dropped here.',
    );
  }

  if (name === aboutToDisplace) {
    throw new Error(
      `--discard-previous names "${name}", which is the database this run just displaced. ` +
        'That copy is the way back if this restore was the wrong one; discard it in a ' +
        'later run, once the restored data has been checked.',
    );
  }
}

/** Drops a database displaced by an *earlier* restore. Already validated. */
async function discard(
  config: Config,
  name: string,
  log: (message: string) => void,
): Promise<void> {
  log(`Dropping "${name}"`);
  await withAdminClient(config.DATABASE_URL, async (admin) => {
    if (!(await databaseExists(admin, name))) {
      log(`  "${name}" does not exist; nothing to drop.`);
      return;
    }
    await dropDatabaseIfExists(admin, name);
    log(`  "${name}" is gone.`);
  });
}
