import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { defaultMigrationsDir } from '../../src/platform/db/migrator.js';
// @ts-expect-error — a plain Node build script, imported for its pure logic.
// `scripts/` is repository tooling and carries no TypeScript project of its own;
// this suite is where it gets to run, because it is the only test runner that
// executes in CI. The import is untyped and that is the whole cost.
import {
  appVersion,
  buildAppManifest,
  buildVersionFile,
  pgMajorFromVersion,
  schemaVersionFromMigrations,
  selectNodeRuntimeFile,
  selectPostgresFile,
} from '../../../scripts/windows/layout.mjs';

/**
 * What the Windows layout says about itself.
 *
 * These are the parts of `scripts/windows/build-layout.mjs` that can be wrong
 * without anything failing: a download that breaks is obvious, and a missing
 * file stops the build — but a `version.json` claiming schema `0014` on a build
 * that carries fifteen migrations produces an installation that refuses to
 * start, in a shop, months later, with nobody on site who can read the error.
 *
 * `schemaVersion` is the number `assertSchemaVersion` compares against the
 * database at boot, so it is tested against the *real* migrations directory as
 * well as against invented ones.
 */

describe('schemaVersionFromMigrations', () => {
  it('is the highest version, not the last one listed', () => {
    // `readdir` order is not guaranteed, and on some filesystems it is
    // effectively random. Taking "the last entry" would work on a developer's
    // laptop and pin the wrong schema on a build machine.
    expect(
      schemaVersionFromMigrations([
        '0002_catalog.sql',
        '0015_system_capability.sql',
        '0001_extensions_and_conventions.sql',
      ]),
    ).toBe('0015');
  });

  it('compares numerically-ordered prefixes rather than by length', () => {
    expect(schemaVersionFromMigrations(['0009_a.sql', '0010_b.sql'])).toBe('0010');
    expect(schemaVersionFromMigrations(['0099_a.sql', '0100_b.sql'])).toBe('0100');
  });

  it('keeps the four-digit form the database reports', () => {
    // `schema_migrations.version` is text, and the boot check is an equality
    // comparison. `"15"` would never match `"0015"`.
    expect(schemaVersionFromMigrations(['0015_system_capability.sql'])).toBe('0015');
  });

  it('ignores files that are not migrations at all', () => {
    expect(
      schemaVersionFromMigrations(['README.md', '0001_extensions_and_conventions.sql', '.keep']),
    ).toBe('0001');
  });

  it('refuses a .sql file that is not a valid migration name', () => {
    // Not skipped: the migration runner refuses to start against a badly named
    // `.sql` file, so a build that ignored one would ship an installation that
    // fails at first boot instead of failing here.
    for (const bad of ['catalog.sql', '15_catalog.sql', '0015-catalog.sql', '0015_Catalog.sql']) {
      expect(() => schemaVersionFromMigrations([bad]), bad).toThrow(
        /not a valid migration filename/,
      );
    }
  });

  it('refuses two migrations that claim the same version', () => {
    expect(() =>
      schemaVersionFromMigrations(['0015_system_capability.sql', '0015_something_else.sql']),
    ).toThrow(/share the version 0015/);
  });

  it('refuses to pin a build with no migrations at all', () => {
    expect(() => schemaVersionFromMigrations([])).toThrow(/No migrations found/);
    expect(() => schemaVersionFromMigrations(['README.md'])).toThrow(/No migrations found/);
  });

  it('agrees with the migrations this repository actually ships', async () => {
    // The assertion that would catch a drift between this derivation and the
    // runner's own filename rule, using the real directory rather than a
    // fixture. If a migration lands that this cannot read, the build should
    // fail here rather than in CI on Windows.
    const filenames = await readdir(defaultMigrationsDir());
    const derived = schemaVersionFromMigrations(filenames);

    expect(derived).toMatch(/^\d{4}$/);
    expect(filenames.some((name) => name.startsWith(`${derived}_`))).toBe(true);
  });
});

describe('pgMajorFromVersion', () => {
  it('reads the major out of a pinned EDB version', () => {
    expect(pgMajorFromVersion('16.15-1')).toBe(16);
    expect(pgMajorFromVersion('17.2-1')).toBe(17);
  });

  it('refuses anything it cannot read a major from', () => {
    // Derived from versions.json rather than hard-coded, so this is what stands
    // between a typo there and a version.json that lies about the cluster.
    for (const bad of ['sixteen', '', 'v16']) {
      expect(() => pgMajorFromVersion(bad), bad).toThrow(/Cannot read a PostgreSQL major version/);
    }
  });
});

describe('appVersion', () => {
  it('prefers what git says this is', () => {
    expect(appVersion('v1.4.0', '0.1.0')).toBe('v1.4.0');
    expect(appVersion('v1.4.0-3-gabc1234', '0.1.0')).toBe('v1.4.0-3-gabc1234');
  });

  it('keeps -dirty, because a build from a modified tree should say so', () => {
    // Permanently, in the file that travels with the artifact. A support
    // conversation that starts "which build is this" deserves the truth.
    expect(appVersion('v1.4.0-dirty', '0.1.0')).toBe('v1.4.0-dirty');
  });

  it('falls back to the workspace version when git cannot answer', () => {
    // A shallow CI clone with no tags, or a tarball with no .git at all.
    expect(appVersion(null, '0.1.0')).toBe('0.1.0');
    expect(appVersion('', '0.1.0')).toBe('0.1.0');
    expect(appVersion('   ', '0.1.0')).toBe('0.1.0');
  });

  it('refuses to produce an empty version', () => {
    expect(() => appVersion(null, '')).toThrow(/what version this build is/);
  });
});

describe('buildVersionFile', () => {
  it('carries exactly the three facts, and nothing derived from the machine', () => {
    const contents = buildVersionFile({
      appVersion: 'v1.4.0',
      schemaVersion: '0015',
      pgMajor: 16,
    });

    expect(contents).toEqual({ appVersion: 'v1.4.0', schemaVersion: '0015', pgMajor: 16 });
    // No build host, no timestamp, no path. The file is the artifact's identity
    // and is compared against configuration at boot; anything that varied
    // between two builds of the same commit would be noise in a diff.
    expect(Object.keys(contents)).toEqual(['appVersion', 'schemaVersion', 'pgMajor']);
  });
});

describe('buildAppManifest', () => {
  const backend = {
    name: '@ekon/backend',
    version: '0.1.0',
    dependencies: {
      '@ekon/shared': '*',
      fastify: '^5.2.0',
      pg: '^8.13.1',
    },
    devDependencies: { vitest: '^4.1.10', tsx: '^4.19.2' },
    scripts: { dev: 'tsx watch src/main.ts' },
  };

  const installed = (name: string) => ({ fastify: '5.2.1', pg: '8.13.3' })[name] ?? '';

  it('pins every dependency to the version this checkout installed', () => {
    // So the tree that ships is the tree the tests ran against, rather than
    // whatever the ranges resolved to on the afternoon of the build.
    const manifest = buildAppManifest(backend, installed, ['@ekon/shared']);
    expect(manifest.dependencies).toEqual({ fastify: '5.2.1', pg: '8.13.3' });
  });

  it('drops the workspace package, which is not on any registry', () => {
    // It is copied into node_modules/@ekon/shared instead; leaving it here
    // would make `npm install` try to fetch a package that does not exist.
    const manifest = buildAppManifest(backend, installed, ['@ekon/shared']);
    expect(manifest.dependencies).not.toHaveProperty('@ekon/shared');
  });

  it('keeps "type": "module", without which nothing starts', () => {
    // Node would read dist/*.js as CommonJS and die on the first import.
    expect(buildAppManifest(backend, installed, ['@ekon/shared']).type).toBe('module');
  });

  it('carries no scripts and no devDependencies', () => {
    // Every script invokes tooling that is not installed on a shop computer,
    // so they could only ever produce a confusing failure.
    const manifest = buildAppManifest(backend, installed, ['@ekon/shared']);
    expect(manifest).not.toHaveProperty('scripts');
    expect(manifest).not.toHaveProperty('devDependencies');
    expect(Object.keys(manifest).sort()).toEqual([
      'dependencies',
      'name',
      'private',
      'type',
      'version',
    ]);
  });

  it('refuses to ship a dependency it cannot pin', () => {
    expect(() => buildAppManifest(backend, () => '', ['@ekon/shared'])).toThrow(
      /Run `npm ci` before building/,
    );
  });

  it('refuses a manifest that ended up with nothing in it', () => {
    expect(() =>
      buildAppManifest({ dependencies: { '@ekon/shared': '*' } }, installed, ['@ekon/shared']),
    ).toThrow(/no dependencies/);
  });
});

describe('what comes out of the two archives', () => {
  it('takes the interpreter from the Node archive and nothing else', () => {
    // No npm, no corepack, no headers. The application ships with its
    // node_modules already installed, so a package manager on a shop computer
    // with no internet buys nothing and is one more thing to go wrong.
    expect(selectNodeRuntimeFile('node-v22.23.2-win-x64/node.exe')).toBe('node.exe');

    for (const other of [
      'node-v22.23.2-win-x64/npm',
      'node-v22.23.2-win-x64/npm.cmd',
      'node-v22.23.2-win-x64/corepack.cmd',
      'node-v22.23.2-win-x64/node_modules/npm/package.json',
      'node-v22.23.2-win-x64/CHANGELOG.md',
      'node-v22.23.2-win-x64/include/node/node.h',
    ]) {
      expect(selectNodeRuntimeFile(other), other).toBeNull();
    }
  });

  it('takes bin, lib, and share from the PostgreSQL archive, with the prefix stripped', () => {
    expect(selectPostgresFile('pgsql/bin/postgres.exe')).toBe('bin/postgres.exe');
    expect(selectPostgresFile('pgsql/lib/libpq.dll')).toBe('lib/libpq.dll');
    expect(selectPostgresFile('pgsql/share/postgresql.conf.sample')).toBe(
      'share/postgresql.conf.sample',
    );
    expect(selectPostgresFile('pgsql/share/timezone/America/Port-au-Prince')).toBe(
      'share/timezone/America/Port-au-Prince',
    );
  });

  it('leaves behind everything a shop computer has no use for', () => {
    // Most of the archive's size, and none of it reachable from anything Ekon
    // does. A database GUI in particular has no business being installed on a
    // till without anybody having asked for it.
    for (const other of [
      'pgsql/doc/postgresql/html/index.html',
      'pgsql/include/libpq-fe.h',
      'pgsql/symbols/postgres.pdb',
      'pgsql/pgAdmin 4/runtime/pgAdmin4.exe',
      'pgsql/installer/server/install-post.vbs',
    ]) {
      expect(selectPostgresFile(other), other).toBeNull();
    }
  });
});
