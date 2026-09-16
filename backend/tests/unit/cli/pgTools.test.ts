import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  databaseNameFromUrl,
  pgEnvFromUrl,
  redactUrl,
  resolvePgBinary,
  withDatabase,
} from '../../../src/cli/pgTools.js';

/**
 * Which PostgreSQL binary runs, and how it is told where to connect.
 *
 * The second is a security property: `ps` shows every process's arguments to
 * every user on the machine, so the password never becomes one.
 */

describe('resolvePgBinary', () => {
  it('uses the installation’s own tools when it has pinned them', () => {
    // pg_dump refuses to dump a newer server, and an archive from a newer
    // pg_dump may not restore into an older one. A stale client first on PATH
    // is a backup that fails at 3am.
    expect(resolvePgBinary('pg_dump', '/opt/ekon/pgsql/bin')).toBe(
      path.join('/opt/ekon/pgsql/bin', 'pg_dump'),
    );
  });

  it('falls back to PATH, which is what a developer’s machine has', () => {
    expect(resolvePgBinary('pg_restore', undefined)).toBe('pg_restore');
    expect(resolvePgBinary('pg_restore', '')).toBe('pg_restore');
    expect(resolvePgBinary('pg_restore', '   ')).toBe('pg_restore');
  });
});

describe('pgEnvFromUrl', () => {
  it('decomposes a connection string so no password is ever an argument', () => {
    expect(pgEnvFromUrl('postgres://ekon:s3cret@127.0.0.1:5433/ekon_prod')).toEqual({
      PGHOST: '127.0.0.1',
      PGPORT: '5433',
      PGUSER: 'ekon',
      PGPASSWORD: 's3cret',
      PGDATABASE: 'ekon_prod',
    });
  });

  it('decodes what the url encoded, so a real password arrives intact', () => {
    const env = pgEnvFromUrl('postgres://ekon:p%40ss%3Aword@localhost/ekon');
    expect(env.PGPASSWORD).toBe('p@ss:word');
  });

  it('sets no password when there is none, leaving the tool its usual means', () => {
    // A developer on a Unix socket authenticates as their own user; an
    // installation on Windows uses a password. Neither should be forced.
    const env = pgEnvFromUrl('postgres://localhost/ekon');
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.PGUSER).toBeUndefined();
    expect(env.PGDATABASE).toBe('ekon');
  });

  it('carries sslmode through, because libpq reads it from the environment too', () => {
    expect(pgEnvFromUrl('postgres://h/ekon?sslmode=require').PGSSLMODE).toBe('require');
  });
});

describe('databaseNameFromUrl', () => {
  it('reads the database a connection string names', () => {
    expect(databaseNameFromUrl('postgres://ekon:pw@localhost:5432/ekon_prod')).toBe('ekon_prod');
  });

  it('refuses a url that names none, rather than defaulting to something', () => {
    expect(() => databaseNameFromUrl('postgres://localhost:5432/')).toThrow(/names no database/);
  });

  it('never puts the password in that refusal', () => {
    expect(() => databaseNameFromUrl('postgres://ekon:s3cret@localhost/')).toThrow(
      /^(?!.*s3cret).*$/,
    );
  });
});

describe('withDatabase', () => {
  it('points the same cluster connection at another database', () => {
    // How the restore drill reaches `postgres` to create its scratch database
    // without a second connection string existing anywhere.
    expect(withDatabase('postgres://ekon:pw@localhost:5432/ekon', 'postgres')).toBe(
      'postgres://ekon:pw@localhost:5432/postgres',
    );
  });
});

describe('redactUrl', () => {
  it('removes the password, because diagnostics travel by email', () => {
    expect(redactUrl('postgres://ekon:s3cret@localhost:5432/ekon')).toBe(
      'postgres://ekon:***@localhost:5432/ekon',
    );
  });

  it('says nothing at all about a url it cannot parse', () => {
    expect(redactUrl('not a url')).toBe('<unparseable DATABASE_URL>');
  });
});
