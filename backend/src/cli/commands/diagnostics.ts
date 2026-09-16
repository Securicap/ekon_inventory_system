import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config/index.js';
import { migrationStatus } from '../../platform/db/migrator.js';
import { createPool } from '../../platform/db/pool.js';
import { backupStamp } from '../backup/naming.js';
import { readLastBackup } from '../../platform/installation/backupState.js';
import { pgToolVersion, redactUrl } from '../pgTools.js';
import { createZip, type ZipEntry } from '../zip.js';

/**
 * Everything support needs to understand an installation, and nothing the shop
 * would mind sending.
 *
 * The situation this exists for: something is wrong on a computer in a shop in
 * another country, on a connection that may be a phone, with nobody on site who
 * can read a log file or run a query. Asking them to describe the problem
 * produces a sentence. Asking them to run one command and send one file
 * produces an answer.
 *
 * **What goes in:** the build, the profile, the schema state, how many rows are
 * in each table, whether the last backup worked, and the logs if the
 * installation keeps any.
 *
 * **What never goes in:** a single business row. Not a product, not a movement,
 * not a user, not a username. The row *counts* are here because "movements: 0"
 * and "movements: 41,208" are different problems, and a count says which
 * without saying what. The database password is redacted out of the connection
 * string wherever it appears.
 *
 * A diagnostics bundle is something a person emails. It has to be safe to email
 * without anybody having to read it first.
 */

export interface DiagnosticsResult {
  file: string;
  bytes: number;
}

export async function runDiagnostics(
  config: Config,
  log: (message: string) => void,
  now: Date = new Date(),
): Promise<DiagnosticsResult> {
  const stateDir = config.EKON_STATE_DIR?.trim();
  if (stateDir === undefined || stateDir === '') {
    throw new Error('EKON_STATE_DIR is not set, so there is nowhere to write the bundle.');
  }

  const entries: ZipEntry[] = [];
  const add = (name: string, text: string): void => {
    entries.push({ name, data: Buffer.from(text, 'utf8'), modified: now });
  };

  add('report.json', `${JSON.stringify(await buildReport(config, now), null, 2)}\n`);
  add('schema.txt', await describeSchema(config));
  add('row-counts.txt', await describeRowCounts(config));

  for (const logEntry of await collectLogs(stateDir, log)) entries.push(logEntry);

  const versionFile = config.EKON_VERSION_FILE?.trim();
  if (versionFile !== undefined && versionFile !== '') {
    try {
      add('version.json', await readFile(versionFile, 'utf8'));
    } catch (error) {
      add('version.json', `could not be read: ${messageOf(error)}\n`);
    }
  }

  const name = `ekon-diagnostics-${backupStamp(now)}.zip`;
  const target = path.join(stateDir, name);
  const archive = createZip(entries);

  await mkdir(stateDir, { recursive: true });
  await writeFile(target, archive);

  log(`Diagnostics written to ${target} (${archive.length} bytes, ${entries.length} files)`);
  log('It contains no product, movement, or user data — only counts and configuration.');

  return { file: target, bytes: archive.length };
}

async function buildReport(config: Config, now: Date): Promise<Record<string, unknown>> {
  const lastBackup =
    config.EKON_STATE_DIR === undefined ? null : await readLastBackup(config.EKON_STATE_DIR);

  return {
    collectedAt: now.toISOString(),
    appVersion: config.APP_VERSION,
    expectedSchemaVersion: config.EXPECTED_SCHEMA_VERSION ?? null,
    profile: config.DEPLOYMENT_PROFILE,
    nodeEnv: config.NODE_ENV,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    // Redacted. A diagnostics bundle travels by email.
    databaseUrl: redactUrl(config.DATABASE_URL),
    databaseSsl: config.DATABASE_SSL,
    host: config.HOST,
    port: config.PORT,
    trustProxy: config.TRUST_PROXY,
    sessionCookieSecure: config.SESSION_COOKIE_SECURE,
    displayTimezone: config.DISPLAY_TIMEZONE,
    backupDir: config.EKON_BACKUP_DIR ?? null,
    stateDir: config.EKON_STATE_DIR ?? null,
    pgBin: config.EKON_PG_BIN ?? null,
    pgDumpVersion: await pgToolVersion('pg_dump', config.EKON_PG_BIN),
    pgRestoreVersion: await pgToolVersion('pg_restore', config.EKON_PG_BIN),
    backupKeepDaily: config.BACKUP_KEEP_DAILY,
    backupKeepWeekly: config.BACKUP_KEEP_WEEKLY,
    lastBackup,
  };
}

async function describeSchema(config: Config): Promise<string> {
  const pool = createPool(config);
  try {
    const rows = await migrationStatus(pool);
    const head = rows.filter((row) => row.applied).at(-1)?.version ?? 'none';
    const lines = [
      `schema head: ${head}`,
      `expected:    ${config.EXPECTED_SCHEMA_VERSION ?? '(not pinned)'}`,
      '',
      ...rows.map(
        (row) =>
          `${row.version}  ${row.filename.padEnd(46)}  ` +
          (row.applied
            ? row.checksumMatches
              ? `applied ${row.appliedAt?.toISOString() ?? ''}`
              : 'APPLIED BUT CHECKSUM CHANGED'
            : 'pending'),
      ),
    ];
    return `${lines.join('\n')}\n`;
  } catch (error) {
    return `The schema could not be read: ${messageOf(error)}\n`;
  } finally {
    await pool.end();
  }
}

/**
 * How many rows each table holds — and only how many.
 *
 * `count(*)` per table rather than the planner's estimate: the tables are a
 * shop's, the query is cheap, and an estimate that said "about 40,000" would be
 * the wrong kind of answer in a file somebody is reading to work out whether a
 * migration lost data.
 */
async function describeRowCounts(config: Config): Promise<string> {
  const pool = createPool(config);
  try {
    const { rows: tables } = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );

    const lines: string[] = [];
    for (const { table_name: table } of tables) {
      try {
        // The name comes from the catalog, not from a caller, and is quoted
        // anyway — nothing in this product interpolates an unquoted identifier.
        const { rows } = await pool.query<{ count: number }>(
          `SELECT count(*) AS count FROM "${table.replace(/"/g, '""')}"`,
        );
        lines.push(`${table.padEnd(40)} ${String(rows[0]?.count ?? 0).padStart(10)}`);
      } catch (error) {
        lines.push(`${table.padEnd(40)} ${messageOf(error)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  } catch (error) {
    return `Row counts could not be read: ${messageOf(error)}\n`;
  } finally {
    await pool.end();
  }
}

/**
 * Whatever log files the installation keeps, up to a size worth emailing.
 *
 * Ekon logs to stdout (pino), so on an installation the *service wrapper* is
 * what writes a file — and where it writes one is the installer's decision, not
 * this application's. So this looks in the conventional place (`logs/` under
 * the state directory) and takes what is there. A missing directory is normal
 * and is reported, not an error: a development machine has no such thing.
 */
async function collectLogs(stateDir: string, log: (message: string) => void): Promise<ZipEntry[]> {
  const logDir = path.join(stateDir, 'logs');
  const collected: ZipEntry[] = [];

  let names: string[];
  try {
    names = await readdir(logDir);
  } catch {
    log(`No log directory at ${logDir}; the bundle carries none.`);
    return collected;
  }

  for (const name of names.sort()) {
    const full = path.join(logDir, name);
    try {
      const info = await stat(full);
      if (!info.isFile()) continue;
      if (info.size > MAX_LOG_BYTES) {
        // The tail, not the head: the interesting part of a log nobody has
        // rotated is the end of it.
        const data = await readFile(full);
        collected.push({
          name: `logs/${name}`,
          data: data.subarray(data.length - MAX_LOG_BYTES),
          modified: info.mtime,
        });
      } else {
        collected.push({ name: `logs/${name}`, data: await readFile(full), modified: info.mtime });
      }
    } catch (error) {
      log(`Could not read ${full}: ${messageOf(error)}`);
    }
  }

  return collected;
}

/** Two megabytes per log file. A bundle has to be small enough to send. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
