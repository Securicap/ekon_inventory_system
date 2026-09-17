import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { readVersionFile } from '../../src/config/versionFile.js';

/**
 * An installed build states its own version, in a file it ships with. There is
 * no deploy pipeline on a shop computer to set `APP_VERSION`, and an upgrade
 * replaces the application directory wholesale — so the file travels with the
 * code and the two cannot drift.
 */

let directory: string;
const minimal = { DATABASE_URL: 'postgres://user:pw@localhost:5432/ekon' };

function write(name: string, contents: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, contents, 'utf8');
  return target;
}

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ekon-version-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('readVersionFile', () => {
  it('reads a build and its schema', () => {
    const file = write('good.json', '{"appVersion":"1.4.0","schemaVersion":"0015"}');
    expect(readVersionFile(file)).toEqual({ appVersion: '1.4.0', schemaVersion: '0015' });
  });

  it('refuses a file that is not there, naming it', () => {
    expect(() => readVersionFile(path.join(directory, 'absent.json'))).toThrow(/absent\.json/);
  });

  it('refuses a file that is not JSON', () => {
    const file = write('broken.json', 'appVersion=1.4.0');
    expect(() => readVersionFile(file)).toThrow(/not valid JSON/);
  });

  it('refuses a schema version that could never match a migration', () => {
    const file = write('bad-schema.json', '{"appVersion":"1.4.0","schemaVersion":"15"}');
    expect(() => readVersionFile(file)).toThrow(/four-digit migration version/);
  });

  it('refuses an empty build name rather than reporting a blank version', () => {
    const file = write('blank.json', '{"appVersion":"  ","schemaVersion":"0015"}');
    expect(() => readVersionFile(file)).toThrow(/appVersion/);
  });

  it('accepts the PostgreSQL major the Windows layout records', () => {
    // `scripts/windows/build-layout.mjs` writes it. The application does not act
    // on it — the installer and a support conversation do — but the file is read
    // with a strict schema, so an unknown field there is a refusal to boot.
    const file = write('pg.json', '{"appVersion":"1.4.0","schemaVersion":"0015","pgMajor":16}');
    expect(readVersionFile(file)).toEqual({
      appVersion: '1.4.0',
      schemaVersion: '0015',
      pgMajor: 16,
    });
  });

  it('does not require it, because a hosted deployment bundles no database', () => {
    const file = write('no-pg.json', '{"appVersion":"1.4.0","schemaVersion":"0015"}');
    expect(readVersionFile(file).pgMajor).toBeUndefined();
  });

  it('refuses a field nobody put there on purpose', () => {
    // Strict: a file carrying `schema_version` alongside `schemaVersion` is two
    // claims about one fact, and the one that is ignored is the one somebody
    // edited.
    const file = write('extra.json', '{"appVersion":"1.4.0","schemaVersion":"0015","channel":"x"}');
    expect(() => readVersionFile(file)).toThrow(/channel/);
  });
});

describe('loadConfig — with a version file', () => {
  it('takes the build and the schema pin from it', () => {
    const file = write('config-good.json', '{"appVersion":"1.4.0","schemaVersion":"0015"}');
    const config = loadConfig({ ...minimal, EKON_VERSION_FILE: file });
    expect(config.APP_VERSION).toBe('1.4.0');
    expect(config.EXPECTED_SCHEMA_VERSION).toBe('0015');
  });

  it('satisfies the pin a local installation must have', () => {
    const file = write('config-local.json', '{"appVersion":"1.4.0","schemaVersion":"0015"}');
    const config = loadConfig({
      ...minimal,
      DEPLOYMENT_PROFILE: 'local',
      EKON_VERSION_FILE: file,
      EKON_BACKUP_DIR: '/var/lib/ekon/backups',
      EKON_STATE_DIR: '/var/lib/ekon/state',
    });
    expect(config.EXPECTED_SCHEMA_VERSION).toBe('0015');
  });

  it('refuses to boot when the environment states a different build', () => {
    // Two answers to "which build is this", and one of them is wrong. Booting
    // on either would mean an installation reporting a version it is not
    // running, and the person who has to work that out is standing in a shop.
    const file = write('config-app.json', '{"appVersion":"1.4.0","schemaVersion":"0015"}');
    expect(() => loadConfig({ ...minimal, EKON_VERSION_FILE: file, APP_VERSION: '1.3.9' })).toThrow(
      /APP_VERSION is "1\.3\.9" but .* says "1\.4\.0"/,
    );
  });

  it('refuses to boot when the environment states a different schema', () => {
    const file = write('config-schema.json', '{"appVersion":"1.4.0","schemaVersion":"0015"}');
    expect(() =>
      loadConfig({ ...minimal, EKON_VERSION_FILE: file, EXPECTED_SCHEMA_VERSION: '0014' }),
    ).toThrow(/EXPECTED_SCHEMA_VERSION is "0014" but .* says "0015"/);
  });

  it('accepts an environment that agrees, rather than insisting it be absent', () => {
    const file = write('config-agree.json', '{"appVersion":"1.4.0","schemaVersion":"0015"}');
    const config = loadConfig({
      ...minimal,
      EKON_VERSION_FILE: file,
      APP_VERSION: '1.4.0',
      EXPECTED_SCHEMA_VERSION: '0015',
    });
    expect(config.APP_VERSION).toBe('1.4.0');
  });

  it('ignores an empty environment value rather than calling it a disagreement', () => {
    const file = write('config-empty.json', '{"appVersion":"1.4.0","schemaVersion":"0015"}');
    const config = loadConfig({ ...minimal, EKON_VERSION_FILE: file, APP_VERSION: '' });
    expect(config.APP_VERSION).toBe('1.4.0');
  });
});
