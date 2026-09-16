import { mkdir, readdir, rm, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config/index.js';
import {
  backupFileName,
  backupStamp,
  checksumFileName,
  parseBackupFileName,
  partialFileName,
  assertUsableTag,
} from '../backup/naming.js';
import {
  checksumSidecarContent,
  hasCustomFormatMagic,
  sha256OfFile,
  CUSTOM_FORMAT_MAGIC,
} from '../backup/integrity.js';
import { selectBackupsToPrune } from '../backup/retention.js';
import { writeLastBackup } from '../../platform/installation/backupState.js';
import { databaseNameFromUrl, runPgTool } from '../pgTools.js';

/**
 * One backup: dump, verify, name, checksum, prune, record.
 *
 * The order is the design, and it is the same order the archived OCI script
 * used, for the same reasons:
 *
 *   dump to a temporary name   ->  a truncated dump can never be mistaken for a
 *                                  finished one
 *   verify, then rename        ->  a file with the final name is a complete,
 *                                  checked file
 *   checksum beside it         ->  "the backup exists" can be turned into "the
 *                                  backup is intact", by anybody, later
 *   prune last                 ->  the last good copy is never deleted because
 *                                  something earlier went wrong
 *
 * What is deliberately **not** here is anything that moves the backup off the
 * machine. ADR 13 requires a copy to leave the computer, and in Ekon Local that
 * is an operator carrying a drive, or a sync the shop sets up — not a network
 * call this command makes. A backup command that uploaded would have
 * credentials for somewhere, on the shop computer, permanently.
 */

export interface BackupOptions {
  tag?: string | undefined;
  /** Injected so a test can pin the filename. */
  now?: Date | undefined;
}

export interface BackupResult {
  file: string;
  bytes: number;
  sha256: string;
  pruned: string[];
}

export async function runBackup(
  config: Config,
  options: BackupOptions,
  log: (message: string) => void,
): Promise<BackupResult> {
  const backupDir = requireDirectory(config.EKON_BACKUP_DIR, 'EKON_BACKUP_DIR');
  const stateDir = config.EKON_STATE_DIR?.trim();
  const tag = options.tag?.trim();
  if (tag !== undefined && tag !== '') assertUsableTag(tag);

  const finishedAt = (): string => new Date().toISOString();
  const stamp = backupStamp(options.now ?? new Date());
  const name = backupFileName(stamp, tag ?? null);
  const partialPath = path.join(backupDir, partialFileName(name));
  const finalPath = path.join(backupDir, name);

  await mkdir(backupDir, { recursive: true });

  try {
    const result = await dumpAndFinalize({
      config,
      backupDir,
      name,
      partialPath,
      finalPath,
      log,
    });

    if (stateDir !== undefined && stateDir !== '') {
      await writeLastBackup(stateDir, {
        finishedAt: finishedAt(),
        ok: true,
        file: name,
        bytes: result.bytes,
        error: null,
      }).catch((error: unknown) => {
        // The dump is on disk and verified. Failing to write the note about it
        // is a real problem — the status screen will keep reporting the
        // previous run — but it is not a reason to call a good backup bad.
        log(`Warning: could not record the backup in ${stateDir}: ${messageOf(error)}`);
      });
    }

    return result;
  } catch (error) {
    // Nothing partial is left anywhere. A `.partial` that survived a crash is
    // the file somebody restores from in a hurry six months later.
    await rm(partialPath, { force: true }).catch(() => {});

    if (stateDir !== undefined && stateDir !== '') {
      await writeLastBackup(stateDir, {
        finishedAt: finishedAt(),
        ok: false,
        file: null,
        bytes: null,
        error: messageOf(error),
      }).catch(() => {});
    }

    throw error;
  }
}

async function dumpAndFinalize(input: {
  config: Config;
  backupDir: string;
  name: string;
  partialPath: string;
  finalPath: string;
  log: (message: string) => void;
}): Promise<BackupResult> {
  const { config, backupDir, name, partialPath, finalPath, log } = input;

  log(`Dumping ${databaseNameFromUrl(config.DATABASE_URL)} -> ${name}`);

  /**
   * `--format=custom` — compressed, and restorable selectively by `pg_restore`,
   * which is what the restore drill uses. Plain SQL would be larger and would
   * force an all-or-nothing `psql` restore.
   *
   * `--no-owner --no-privileges` — the dump carries data and schema, not the
   * role names of the machine it came from. A restore onto a fresh installation
   * has different roles (0014's `ekon_app` is created by a migration, and the
   * login user is created per environment), and an archive that tried to
   * reinstate ownership would fail on every one of them.
   */
  await runPgTool(
    'pg_dump',
    [
      '--format=custom',
      '--compress=6',
      '--no-owner',
      '--no-privileges',
      '--file',
      partialPath,
      databaseNameFromUrl(config.DATABASE_URL),
    ],
    { databaseUrl: config.DATABASE_URL, pgBin: config.EKON_PG_BIN, log },
  );

  const { size } = await stat(partialPath);
  if (size === 0) throw new Error('pg_dump produced an empty file.');

  // Catching a shell error message that landed in the file here is cheaper than
  // discovering it during a restore six months from now.
  if (!(await hasCustomFormatMagic(partialPath))) {
    throw new Error(
      `The dump does not begin with "${CUSTOM_FORMAT_MAGIC}" and is not a PostgreSQL ` +
        'custom-format archive. Nothing has been kept.',
    );
  }

  // Atomic within a directory: from here on, the final name is a complete file.
  await rename(partialPath, finalPath);

  const sha256 = await sha256OfFile(finalPath);
  await writeFile(
    path.join(backupDir, checksumFileName(name)),
    checksumSidecarContent(sha256, name),
    'utf8',
  );

  log(`Backup complete: ${finalPath} (${formatBytes(size)})`);
  log(`sha256 ${sha256}`);

  const pruned = await prune(backupDir, config, log);
  return { file: name, bytes: size, sha256, pruned };
}

/**
 * Deletes what retention says may go, and nothing else.
 *
 * The selection is a pure function over filenames (`selectBackupsToPrune`); this
 * only carries out its answer. A failure to delete is reported and does not
 * fail the backup: the dump is already written and verified, and a full disk
 * next week is a smaller problem than a scheduled job that reports failure
 * every night until somebody stops reading it.
 */
async function prune(
  backupDir: string,
  config: Config,
  log: (message: string) => void,
): Promise<string[]> {
  const entries = await readdir(backupDir);
  const backups = entries
    .map((entry) => parseBackupFileName(entry))
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);

  const doomed = selectBackupsToPrune(backups, {
    keepDaily: config.BACKUP_KEEP_DAILY,
    keepWeekly: config.BACKUP_KEEP_WEEKLY,
  });

  const removed: string[] = [];
  for (const backup of doomed) {
    try {
      await rm(path.join(backupDir, backup.name), { force: true });
      await rm(path.join(backupDir, checksumFileName(backup.name)), { force: true });
      removed.push(backup.name);
      log(`Pruned ${backup.name}`);
    } catch (error) {
      log(`Warning: could not prune ${backup.name}: ${messageOf(error)}`);
    }
  }

  if (removed.length === 0) log('Nothing to prune.');
  return removed;
}

export function requireDirectory(value: string | undefined, variable: string): string {
  const directory = value?.trim();
  if (directory === undefined || directory === '') {
    throw new Error(
      `${variable} is not set. This command writes to a directory the installation owns, ` +
        'and will not guess one.',
    );
  }
  return directory;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
