import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBackup } from '../../src/cli/commands/backup.js';
import { parseChecksumSidecar, sha256OfFile } from '../../src/cli/backup/integrity.js';
import { runRestore } from '../../src/cli/commands/restore.js';
import { runRestoreDrill } from '../../src/cli/commands/restoreDrill.js';
import { withAdminClient } from '../../src/cli/adminDb.js';
import { readLastBackup } from '../../src/platform/installation/backupState.js';
import { loadConfig, type Config } from '../../src/config/index.js';
import { loadMigrations } from '../../src/platform/db/migrator.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Backup, then prove the backup restores — against real PostgreSQL, with the
 * real `pg_dump` and `pg_restore`.
 *
 * ADR 13 makes this a release requirement rather than advice: an installation
 * is not fit to hold real inventory until a backup runs and a restore has been
 * performed from it. A test that mocked the tools would prove that this code
 * calls them, which is not the thing anybody needs to know.
 *
 * **Skipped when the PostgreSQL client tools are absent**, which is a
 * developer's machine that runs the database in Docker — and *failed* in CI,
 * where the workflow installs `postgresql-client-16` precisely so this runs. A
 * silently skipped backup test in CI would be worse than no backup test.
 */

const HAVE_PG_TOOLS = hasPgTools();
const IN_CI = process.env.CI === 'true';

function hasPgTools(): boolean {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    execFileSync('pg_restore', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!HAVE_PG_TOOLS && IN_CI) {
  throw new Error(
    'pg_dump and pg_restore are not on PATH. CI must install them — see the ' +
      '"PostgreSQL client tools" step in .github/workflows/ci.yml (apt package ' +
      'postgresql-client-16). Refusing to skip the backup test in CI.',
  );
}

describe.skipIf(!HAVE_PG_TOOLS)('backup and restore drill', () => {
  let db: TestDatabase;
  let backupDir: string;
  let stateDir: string;
  let config: Config;
  const written: string[] = [];

  const log = (message: string): void => {
    written.push(message);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    backupDir = await mkdtemp(path.join(tmpdir(), 'ekon-backup-'));
    stateDir = await mkdtemp(path.join(tmpdir(), 'ekon-backup-state-'));

    const base = loadConfig();
    config = {
      ...base,
      // The dump and the drill are operator work: they run as the owner, not as
      // the restricted application role, which may not create a database.
      DATABASE_URL: (db.pool.options as { connectionString?: string }).connectionString ?? '',
      EKON_BACKUP_DIR: backupDir,
      EKON_STATE_DIR: stateDir,
    };

    // An owner, so the drill's "somebody could sign in to this" check is a real
    // check rather than one that passes because the fixture happened to fit.
    await db.pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, is_active,
                          created_at, updated_at)
       VALUES (gen_random_uuid(), 'marie.j', 'Marie Joseph',
               '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA', 'OWNER', true, now(), now())`,
    );
  });

  afterAll(async () => {
    await db.drop();
    await rm(backupDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('writes a verified dump, a checksum beside it, and a record of the run', async () => {
    const result = await runBackup(config, {}, log);

    const entries = await readdir(backupDir);
    expect(entries).toContain(result.file);
    expect(entries).toContain(`${result.file}.sha256`);

    // Nothing partial survives a finished run.
    expect(entries.filter((name) => name.endsWith('.partial'))).toEqual([]);
    expect(entries.filter((name) => name.startsWith('.'))).toEqual([]);

    // The sidecar is the file's real hash, in the format `sha256sum --check`
    // reads — so an operator on any machine can verify a backup without Ekon.
    const sidecar = await readFile(path.join(backupDir, `${result.file}.sha256`), 'utf8');
    expect(parseChecksumSidecar(sidecar)).toBe(
      await sha256OfFile(path.join(backupDir, result.file)),
    );
    expect(sidecar).toBe(`${result.sha256}  ${result.file}\n`);

    // And the record the status screen reads.
    const recorded = await readLastBackup(stateDir);
    expect(recorded).toMatchObject({ ok: true, file: result.file });
  });

  it('produces an archive that restores, into a database it then destroys', async () => {
    const [file] = (await readdir(backupDir)).filter((name) => name.endsWith('.dump'));
    if (file === undefined) throw new Error('the previous test produced no dump');

    written.length = 0;
    await expect(
      runRestoreDrill(config, path.join(backupDir, file), {}, log),
    ).resolves.toBeUndefined();

    const output = written.join('\n');
    expect(output).toContain('sha256 matches the sidecar');
    expect(output).toContain('pg_restore completed without error');
    expect(output).toContain('core tables are present');
    expect(output).toContain('active owner');
    expect(output).toContain('every balance row has movements behind it');
    expect(output).toContain('RESTORE DRILL PASSED');

    // The drill database is gone. One that lingered would fill the disk one
    // night a week, and the next drill would refuse to create it.
    const { rows } = await db.pool.query<{ count: number }>(
      `SELECT count(*) AS count FROM pg_database WHERE datname = 'ekon_restore_drill'`,
    );
    expect(rows[0]?.count).toBe(0);
  });

  it('refuses a corrupted archive rather than restoring it', async () => {
    const [file] = (await readdir(backupDir)).filter((name) => name.endsWith('.dump'));
    if (file === undefined) throw new Error('no dump to corrupt');

    const target = path.join(backupDir, 'ekon-20200101T000000Z-corrupt.dump');
    const original = await readFile(path.join(backupDir, file));
    // Keep the magic bytes, change the contents: exactly the failure a checksum
    // exists to catch, and one the magic-byte check alone would miss.
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
    await writeFile(target, corrupted);
    await writeFile(
      `${target}.sha256`,
      `${await sha256OfFile(path.join(backupDir, file))}  ${path.basename(target)}\n`,
    );

    await expect(runRestoreDrill(config, target, {}, log)).rejects.toThrow(/corrupt/);
  });

  it('refuses a file from outside the backup directory unless told', async () => {
    // The drill drops and recreates a database and runs a restore. Pointing it
    // at an arbitrary file is how that capability gets borrowed for something
    // else; `--allow-external` is the deliberate way to test a copy an operator
    // carried in on a drive.
    const elsewhere = path.join(stateDir, 'ekon-20260101T000000Z.dump');
    await writeFile(elsewhere, 'pg_dump: error: connection to server failed\n');

    await expect(runRestoreDrill(config, elsewhere, {}, log)).rejects.toThrow(
      /not under EKON_BACKUP_DIR/,
    );
    // With the flag it gets as far as the integrity check, which is what
    // refuses it — a different failure, and the right one.
    await expect(runRestoreDrill(config, elsewhere, { allowExternal: true }, log)).rejects.toThrow(
      /not a PostgreSQL custom-format archive/,
    );
  });

  it('keeps a tagged backup and prunes the day’s other copies', async () => {
    // Retention is exercised as a whole here; the rules themselves are unit
    // tested. What this proves is that the command deletes the dump *and* its
    // sidecar, and never a tagged file.
    const tagged = await runBackup(config, { tag: 'before-upgrade' }, log);
    const first = await runBackup(config, { now: new Date('2020-01-01T01:00:00Z') }, log);
    await runBackup(config, { now: new Date('2020-01-01T02:00:00Z') }, log);

    const entries = await readdir(backupDir);
    expect(entries).toContain(tagged.file);
    expect(entries).toContain(`${tagged.file}.sha256`);
    // The older of two dumps from the same long-past day is gone, sidecar too.
    expect(entries).not.toContain(first.file);
    expect(entries).not.toContain(`${first.file}.sha256`);
  });

  it('records a failure, and leaves nothing behind, when the dump cannot run', async () => {
    // The state file is how an owner finds out that backups have been failing
    // on a machine with no monitoring and nobody on site. A run that failed
    // silently would read on the status screen exactly like a shop that never
    // set one up.
    const broken: Config = {
      ...config,
      DATABASE_URL: config.DATABASE_URL.replace(/\/[^/]+$/, '/ekon_does_not_exist'),
    };

    await expect(runBackup(broken, {}, log)).rejects.toThrow();

    const recorded = await readLastBackup(stateDir);
    expect(recorded?.ok).toBe(false);
    expect(recorded?.file).toBeNull();

    const entries = await readdir(backupDir);
    expect(entries.filter((name) => name.endsWith('.partial'))).toEqual([]);
  });
});

/**
 * Putting a backup back — into the database the shop actually uses.
 *
 * The most dangerous command in the product, so it gets its own database: this
 * suite renames the live one out from under itself, which is exactly what the
 * command does on an installation.
 *
 * What is asserted is the shape of the safety rather than only the happy path:
 * it refuses without `--yes`, the displaced database survives, and dropping one
 * takes a second command that names it.
 */
describe.skipIf(!HAVE_PG_TOOLS)('restore', () => {
  let db: TestDatabase;
  let backupDir: string;
  let config: Config;
  let dumpPath: string;
  const written: string[] = [];

  const log = (message: string): void => {
    written.push(message);
  };

  /** The databases an earlier restore displaced and deliberately kept. */
  async function displacedDatabases(): Promise<string[]> {
    const { rows } = await db.pool.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname`,
      [`ekon_pre_restore_%`],
    );
    return rows.map((row) => row.datname);
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    backupDir = await mkdtemp(path.join(tmpdir(), 'ekon-restore-'));

    // A restore terminates every other connection before renaming the live
    // database — including this suite's idle pooled clients. Without a
    // listener, `pg.Pool` turns that into an uncaught exception. The
    // application attaches the same handler for the same reason (see
    // `buildApp`); here it is what lets the suite keep using the pool
    // afterwards, which is exactly what an operator does.
    db.pool.on('error', () => {});
    db.appPool.on('error', () => {});

    config = {
      ...loadConfig(),
      DATABASE_URL: (db.pool.options as { connectionString?: string }).connectionString ?? '',
      EKON_BACKUP_DIR: backupDir,
      EKON_STATE_DIR: undefined,
    };

    await db.pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, is_active,
                          created_at, updated_at)
       VALUES (gen_random_uuid(), 'marie.j', 'Marie Joseph',
               '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA', 'OWNER', true, now(), now())`,
    );

    const backup = await runBackup(config, {}, log);
    dumpPath = path.join(backupDir, backup.file);
  });

  afterAll(async () => {
    // Every database this suite displaced, including the ones it kept on
    // purpose. `db.drop()` only knows about the live name.
    for (const name of await displacedDatabases()) {
      await withAdminClient(config.DATABASE_URL, (admin) =>
        admin.query(`DROP DATABASE IF EXISTS "${name}"`),
      );
    }
    await db.drop();
    await rm(backupDir, { recursive: true, force: true });
  });

  it('refuses without --yes, and says exactly what it would have done', async () => {
    // A restore is a decision. The archived runbook deliberately had no
    // restore-production script for this reason; what changed is that there is
    // no operator with a runbook standing next to a shop computer.
    await expect(runRestore(config, dumpPath, {}, log)).rejects.toThrow(/without --yes/);

    const { rows } = await db.pool.query<{ count: number }>(`SELECT count(*) AS count FROM users`);
    expect(rows[0]?.count).toBe(1);
  });

  it('brings back what was lost, and keeps the database it replaced', async () => {
    // The damage: somebody deleted the owner.
    await db.pool.query(`DELETE FROM users`);

    written.length = 0;
    await runRestore(config, dumpPath, { yes: true }, log);

    const { rows } = await db.pool.query<{ username: string }>(`SELECT username FROM users`);
    expect(rows.map((row) => row.username)).toEqual(['marie.j']);

    // Nothing was destroyed: the database that was there is renamed and kept,
    // so restoring the wrong archive at four in the morning is reversible.
    expect(await displacedDatabases()).toHaveLength(1);
    expect(written.join('\n')).toMatch(/Restore complete/);
  });

  it('brings the restored database up to the schema this build expects', async () => {
    // A backup may predate the installed build; an upgrade migrates in place
    // rather than asking a shop to re-enter anything (ADR 13, point 7).
    const { rows } = await db.pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
    );
    const migrations = await loadMigrations();
    expect(rows[0]?.version).toBe(migrations.at(-1)?.version);
  });

  it('refuses to drop anything that is not a database it displaced, before touching anything', async () => {
    const before = await displacedDatabases();

    await expect(
      runRestore(config, dumpPath, { yes: true, discardPrevious: 'postgres' }, log),
    ).rejects.toThrow(/not the name of a database a restore displaced/);

    // Refused *first*: a --discard-previous that names the wrong thing must not
    // be discovered after the live database has already been renamed.
    expect(await displacedDatabases()).toEqual(before);
  });

  it('refuses to drop the copy this very run is about to displace', async () => {
    // The guard that stops a scripted restore loop from eating its own safety
    // net. Reachable here because the clock is pinned, so the name this run
    // would create is known.
    const now = new Date('2026-09-15T03:15:00.000Z');

    await expect(
      runRestore(
        config,
        dumpPath,
        { yes: true, discardPrevious: 'ekon_pre_restore_20260915T031500Z', now },
        log,
      ),
    ).rejects.toThrow(/database this run just displaced/);
  });

  it('drops a previously displaced database only when it is named', async () => {
    const before = await displacedDatabases();
    const earlier = before[0];
    if (earlier === undefined) throw new Error('nothing was displaced by the earlier restore');

    await runRestore(config, dumpPath, { yes: true, discardPrevious: earlier }, log);

    const remaining = await displacedDatabases();
    // The named one is gone. Everything else this suite displaced is still
    // there, including the copy this run just made: nothing is dropped that was
    // not typed.
    expect(remaining).not.toContain(earlier);
    expect(remaining).toHaveLength(before.length);
  });
});
