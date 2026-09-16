import { statfs } from 'node:fs/promises';
import type { SystemStatusResponse } from '@ekon/shared';
import type { Config } from '../../config/index.js';
import { currentSchemaVersion } from '../../platform/db/migrator.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import { readLastBackup } from '../../platform/installation/backupState.js';

/**
 * What the installation says about itself.
 *
 * Five facts, each read from the place that actually knows it: the build from
 * the configuration, the schema from the database, the last backup from the
 * file `ekon-ctl backup` writes, and the free space from the filesystem. None
 * of them is cached, and none is computed from business rows.
 *
 * **Nothing here can fail the request.** The schema read, the state file, and
 * the disk all degrade to `null` rather than throwing, and the reason is the
 * situation this screen is for: somebody has opened it *because* something is
 * wrong. An endpoint that answered 500 when one of four readings was
 * unavailable would be silent at exactly the moment its other three answers
 * were most worth having.
 */

export interface SystemStatusServiceDeps {
  config: Config;
  pool: DatabasePool;
}

export interface SystemStatusService {
  read(): Promise<SystemStatusResponse>;
}

export function createSystemStatusService(deps: SystemStatusServiceDeps): SystemStatusService {
  const { config, pool } = deps;

  return {
    async read() {
      const [schemaVersion, lastBackup, backupDirFreeBytes] = await Promise.all([
        readSchemaVersion(pool),
        readBackupRecord(config),
        readFreeBytes(config),
      ]);

      return {
        appVersion: config.APP_VERSION,
        schemaVersion,
        profile: config.DEPLOYMENT_PROFILE,
        lastBackup,
        backupDirFreeBytes,
      };
    },
  };
}

/**
 * The migration the database is actually at — not what this build expected.
 *
 * The two agree on a healthy installation, and when they do not, the database's
 * answer is the useful one: the build's expectation is already a boot check
 * (`assertSchemaVersion`), and repeating it here would tell an owner what the
 * software believes rather than what is true.
 */
async function readSchemaVersion(pool: DatabasePool): Promise<string | null> {
  try {
    return await currentSchemaVersion(pool);
  } catch {
    return null;
  }
}

async function readBackupRecord(config: Config): Promise<SystemStatusResponse['lastBackup']> {
  const stateDir = config.EKON_STATE_DIR?.trim();
  if (stateDir === undefined || stateDir === '') return null;
  return readLastBackup(stateDir);
}

/**
 * Free space where backups are written.
 *
 * `bavail` — blocks available to an unprivileged process — rather than `bfree`,
 * because the reserved blocks a filesystem keeps for root are not space a
 * backup can use, and reporting them would say a dump will fit when it will
 * not. A full disk is the backup failure nobody sees coming: it is silent, it
 * happens at three in the morning, and the first sign of it is a restore with
 * nothing to restore from.
 *
 * `null` when no backup directory is configured, or when the directory does not
 * exist yet, or when the filesystem cannot be read. All three mean the same
 * thing to a screen — there is no number to show — and none is worth a 500.
 */
async function readFreeBytes(config: Config): Promise<number | null> {
  const backupDir = config.EKON_BACKUP_DIR?.trim();
  if (backupDir === undefined || backupDir === '') return null;

  try {
    const stats = await statfs(backupDir);
    const free = Number(stats.bsize) * Number(stats.bavail);
    return Number.isFinite(free) && free >= 0 ? Math.floor(free) : null;
  } catch {
    return null;
  }
}
