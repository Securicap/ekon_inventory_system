#!/usr/bin/env node
/**
 * Assembles the Windows application layout: everything an installation needs,
 * in the shape it will have on the shop computer, and nothing that runs yet.
 *
 *     node scripts/windows/build-layout.mjs [--skip-build] [--skip-install]
 *
 * What comes out (ADR 13's `Program Files\Ekon\`):
 *
 *     dist-windows/
 *       app/                  everything the service is
 *         node.exe            the pinned runtime, and only the interpreter
 *         package.json        pruned: prod dependencies, "type": "module"
 *         version.json        appVersion · schemaVersion · pgMajor
 *         dist/               the compiled backend — dist/main.js is the entry
 *         public/             the built frontend, served from the same origin
 *         migrations/         applied by `ekon-ctl migrate` on install/upgrade
 *         node_modules/       production dependencies, win32-x64 native binaries
 *           @ekon/shared/     copied, not linked — it is not on a registry
 *       pgsql/                the bundled PostgreSQL 16: bin, lib, share
 *
 * The layout mirrors `backend/` at its root on purpose. `dist/main.js` resolves
 * its migrations as `../../../migrations`, and `STATIC_DIR=./public` resolves
 * from the working directory — so a service started with its working directory
 * set to `app/` finds both without a single path being configured.
 *
 * **This phase produces a directory tree and nothing that runs.** There is no
 * service, no launcher, no installer, and no cluster initialisation here. The
 * point of it is that the tree can be built, inspected, and argued about before
 * anything is wired to start automatically on somebody's till.
 *
 * Both bundled artifacts are **pinned and checksummed** in `versions.json`, and
 * verified before a single byte is unpacked. A build that cannot prove what it
 * downloaded stops — it does not warn and continue. The software that holds a
 * business's inventory should not be assembled out of whatever the network
 * happened to return.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { once } from 'node:events';
import {
  appVersion,
  buildAppManifest,
  buildVersionFile,
  pgMajorFromVersion,
  schemaVersionFromMigrations,
  selectNodeRuntimeFile,
  selectPostgresFile,
} from './layout.mjs';
import { extractZip } from './zip.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VERSIONS_FILE = path.join(ROOT, 'scripts/windows/versions.json');
const OUTPUT = path.join(ROOT, 'dist-windows');
const APP = path.join(OUTPUT, 'app');
const PGSQL = path.join(OUTPUT, 'pgsql');
const CACHE = path.join(ROOT, '.cache/windows-artifacts');

/** The workspace package that ships as files rather than from a registry. */
const SHARED_PACKAGE = '@ekon/shared';

/**
 * The native binary `@node-rs/argon2` needs on Windows.
 *
 * Asserted after the install rather than assumed, because this is the one way
 * the layout can be silently wrong: npm selects optional dependencies by the
 * platform it is running on, so a layout built on Linux without `--os=win32`
 * gets a `linux-x64` binary that looks perfectly healthy in a directory listing
 * and dies on the first password hash — which, on a shop computer, is the first
 * sign-in of the first morning.
 */
const REQUIRED_NATIVE_PACKAGE = '@node-rs/argon2-win32-x64-msvc';

const skipBuild = process.argv.includes('--skip-build');
const skipInstall = process.argv.includes('--skip-install');

async function main() {
  const versions = JSON.parse(await readFile(VERSIONS_FILE, 'utf8'));

  banner('Ekon — Windows application layout');
  console.log(`  node       ${versions.node.version} (${versions.node.platform})`);
  console.log(`  postgresql ${versions.postgresql.version} (${versions.postgresql.platform})`);
  console.log(`  output     ${path.relative(ROOT, OUTPUT)}/`);

  // Fetched first, and verified before anything is built: a checksum mismatch
  // should cost seconds, not a full workspace build.
  const nodeArchive = await fetchVerified(versions.node, 'node');
  const postgresArchive = await fetchVerified(versions.postgresql, 'postgresql');

  if (skipBuild) {
    console.log('\n--skip-build: using whatever is already built.');
  } else {
    banner('Building the workspaces');
    run('npm', ['run', 'build'], ROOT);
  }

  banner('Assembling');
  // Wholesale, every time. An upgrade replaces `Program Files\Ekon\` wholesale
  // (ADR 13, point 7), and a build directory that accumulated files from an
  // earlier run would produce a layout nobody could reason about — the one
  // failure mode that survives into an installer.
  //
  // Retried, because this is a tree of freshly written `.exe` files on Windows:
  // a virus scanner or an indexer holding a handle for a moment turns the
  // delete into EBUSY or ENOTEMPTY, and failing the build over a handle that
  // will be gone in 200 ms would be a flaky build for no reason.
  await rm(OUTPUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(APP, { recursive: true });

  await unpackNode(nodeArchive);
  await copyApplication();
  await unpackPostgres(postgresArchive);
  const manifest = await writeAppManifest();
  if (!skipInstall) await installProductionDependencies();
  await copySharedPackage();
  await writeVersionFile(versions);

  await report(manifest);
}

// ---------------------------------------------------------------------------
// Download and verify
// ---------------------------------------------------------------------------

/**
 * The path to a pinned artifact on disk, having proved it is the pinned
 * artifact.
 *
 * The cache is never trusted on its presence alone: a cached file is hashed
 * exactly as a freshly downloaded one is, so a truncated download from last
 * week, a corrupted disk, or somebody's helpful edit is caught rather than
 * built into the product. A cached file that fails is deleted and fetched once
 * more; a fresh download that fails is fatal.
 *
 * Both the download and the verification work off the file rather than a buffer
 * in memory, because the file is the thing that gets cached and reused — hashing
 * the bytes on their way past and then writing them is a check of something
 * slightly different from what the next run will pick up.
 */
async function fetchVerified(artifact, label) {
  await mkdir(CACHE, { recursive: true });
  const target = path.join(CACHE, path.basename(new URL(artifact.url).pathname));

  if (await exists(target)) {
    const digest = await sha256OfFile(target);
    if (digest === artifact.sha256) {
      console.log(`\n  ${label}: cached ${path.relative(ROOT, target)} (sha256 verified)`);
      return target;
    }
    console.log(
      `\n  ${label}: cached copy does not match its pinned checksum — discarding and re-downloading.`,
    );
    await rm(target, { force: true });
  }

  await download(artifact.url, target, label);
  const digest = await sha256OfFile(target);

  if (digest !== artifact.sha256) {
    // Deleted, not kept: a file that failed verification must not be sitting in
    // the cache for the next run to find, and must not be available for
    // somebody to inspect and decide looks fine.
    await rm(target, { force: true });
    throw new Error(
      `${label}: checksum mismatch — refusing to use this file.\n` +
        `  url      ${artifact.url}\n` +
        `  expected ${artifact.sha256}\n` +
        `  actual   ${digest}\n\n` +
        'Either the download was corrupted or the upstream file changed. Do not update the ' +
        'checksum in versions.json to make this pass: re-download over HTTPS, confirm what ' +
        'changed and why, and rotate the pin deliberately.',
    );
  }

  console.log(`  ${label}: sha256 verified`);
  return target;
}

/**
 * Streams a URL to `target` via a `.partial`, so a killed run caches nothing
 * and the next one cannot find a half-file to trust.
 *
 * Streamed to disk rather than collected in memory: the PostgreSQL archive is
 * about 350 MB, and buffering it whole — then concatenating it — would peak at
 * twice that on a build machine doing several things at once, for no benefit.
 */
async function download(url, target, label) {
  console.log(`\n  ${label}: downloading ${url}`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${label}: ${url} answered ${response.status} ${response.statusText}.`);
  }

  const expected = Number(response.headers.get('content-length') ?? 0);
  const partial = `${target}.partial`;
  const sink = createWriteStream(partial);

  let received = 0;
  let announced = 0;

  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (!sink.write(chunk)) await once(sink, 'drain');

      // A 350 MB download that printed nothing would be indistinguishable from
      // a hang, and somebody would kill it.
      if (received - announced >= 25 * 1024 * 1024) {
        announced = received;
        console.log(`    ${megabytes(received)}${expected ? ` of ${megabytes(expected)}` : ''}`);
      }
    }
    sink.end();
    await once(sink, 'finish');
  } catch (error) {
    sink.destroy();
    await rm(partial, { force: true });
    throw error;
  }

  if (expected && received !== expected) {
    await rm(partial, { force: true });
    throw new Error(
      `${label}: expected ${expected} bytes but received ${received}. The download was ` +
        'truncated; nothing has been cached.',
    );
  }

  await rename(partial, target);
  console.log(`    ${megabytes(received)} downloaded`);
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

async function unpackNode(archivePath) {
  const { files } = await extractZip(await readFile(archivePath), APP, selectNodeRuntimeFile);
  if (files !== 1) {
    throw new Error(
      `Expected exactly one file (node.exe) from the Node archive, got ${files}. ` +
        'The archive layout has changed; check scripts/windows/layout.mjs.',
    );
  }
  const { size } = await stat(path.join(APP, 'node.exe'));
  console.log(`  node.exe                  ${megabytes(size)}`);
}

async function unpackPostgres(archivePath) {
  const { files, bytes } = await extractZip(await readFile(archivePath), PGSQL, selectPostgresFile);
  if (files === 0) {
    throw new Error(
      'The PostgreSQL archive yielded no files. Its internal layout has changed; check ' +
        'selectPostgresFile in scripts/windows/layout.mjs.',
    );
  }

  // The three binaries every later phase depends on: the server, the tool that
  // creates the cluster, and the one `ekon-ctl backup` spawns. Checked here
  // because "the zip extracted fine" and "the layout is usable" are different
  // claims, and only the second one matters.
  for (const binary of [
    'postgres.exe',
    'initdb.exe',
    'pg_dump.exe',
    'pg_restore.exe',
    'psql.exe',
  ]) {
    await assertExists(path.join(PGSQL, 'bin', binary), `PostgreSQL ${binary}`);
  }

  console.log(`  pgsql/                    ${files} files, ${megabytes(bytes)}`);
}

/**
 * The built application: compiled backend, built frontend, migrations.
 *
 * Copied rather than rebuilt in place, so what ships is exactly what the tests
 * in this repository ran against.
 */
async function copyApplication() {
  const pieces = [
    ['backend/dist', 'dist', 'the compiled backend'],
    ['backend/public', 'public', 'the built frontend'],
    ['backend/migrations', 'migrations', 'the migrations'],
  ];

  for (const [from, to, what] of pieces) {
    const source = path.join(ROOT, from);
    await assertExists(source, `${what} (${from})`, 'Run `npm run build` first.');
    await cp(source, path.join(APP, to), { recursive: true });
  }

  await assertExists(path.join(APP, 'dist/main.js'), 'the service entry point (dist/main.js)');
  await assertExists(
    path.join(APP, 'dist/cli/ekonctl.js'),
    'the operator CLI (dist/cli/ekonctl.js)',
  );
  await assertExists(
    path.join(APP, 'public/index.html'),
    'the frontend entry point (public/index.html)',
  );

  console.log('  dist/ public/ migrations/ copied');
}

/** Writes `app/package.json`, pinned to the versions this repository installed. */
async function writeAppManifest() {
  const backendManifest = JSON.parse(
    await readFile(path.join(ROOT, 'backend/package.json'), 'utf8'),
  );

  const manifest = buildAppManifest(backendManifest, installedVersionOf, [SHARED_PACKAGE]);

  await writeFile(path.join(APP, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `  package.json              ${Object.keys(manifest.dependencies).length} dependencies, pinned`,
  );

  return manifest;
}

/**
 * The version installed in this checkout, read from the tree npm actually
 * resolved — so the layout ships what the tests ran against rather than
 * whatever the semver ranges resolve to today.
 */
function installedVersionOf(name) {
  for (const base of [path.join(ROOT, 'node_modules'), path.join(ROOT, 'backend/node_modules')]) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(base, name, 'package.json'), 'utf8'));
      if (typeof manifest.version === 'string') return manifest.version;
    } catch {
      // Not in this tree; try the next.
    }
  }
  throw new Error(
    `"${name}" is not installed in this checkout, so its version cannot be pinned. ` +
      'Run `npm ci` first.',
  );
}

/**
 * Installs production dependencies into `app/`, for Windows.
 *
 * `--os=win32 --cpu=x64` so a layout built on Linux gets the same native
 * binaries a layout built on Windows does; on Windows they are a no-op. The
 * flags are not trusted to have worked — `REQUIRED_NATIVE_PACKAGE` is asserted
 * afterwards, because npm ignores flags it does not recognise and an old npm
 * would otherwise produce a layout that is wrong in the one way nobody notices
 * until somebody tries to sign in.
 *
 * `--ignore-scripts` is deliberately **not** passed: the native packages here
 * ship prebuilt binaries as optional dependencies, and a package that needed to
 * run an install script to be usable would need to run it.
 */
async function installProductionDependencies() {
  console.log('\n  installing production dependencies (win32-x64)…');

  run(
    'npm',
    [
      'install',
      '--omit=dev',
      '--os=win32',
      '--cpu=x64',
      '--no-audit',
      '--no-fund',
      '--install-strategy=hoisted',
    ],
    APP,
  );

  // npm leaves a lockfile behind. It describes a tree that is already fully
  // materialised and that nothing on a shop computer will ever reinstall.
  await rm(path.join(APP, 'package-lock.json'), { force: true });

  await assertExists(
    path.join(APP, 'node_modules', REQUIRED_NATIVE_PACKAGE),
    `the Windows build of argon2 (${REQUIRED_NATIVE_PACKAGE})`,
    'npm selected optional dependencies for the wrong platform. Check that this npm supports ' +
      '--os and --cpu (npm 10 or newer).',
  );

  await assertExists(path.join(APP, 'node_modules/fastify'), 'fastify');
  await assertExists(path.join(APP, 'node_modules/pg'), 'pg');
  console.log(`  node_modules/             installed, ${REQUIRED_NATIVE_PACKAGE} present`);
}

/**
 * Puts `@ekon/shared` where Node will find it.
 *
 * Copied into `node_modules/@ekon/shared` rather than linked. A junction or a
 * symlink survives on the machine that made it and breaks the moment the tree
 * is copied into `Program Files` by an installer — which is precisely what
 * happens to this directory. It is a hundred kilobytes; the copy is free and it
 * cannot dangle.
 */
async function copySharedPackage() {
  const source = path.join(ROOT, 'shared');
  await assertExists(path.join(source, 'dist/index.js'), 'the built shared package (shared/dist)');

  const target = path.join(APP, 'node_modules', SHARED_PACKAGE);
  await mkdir(target, { recursive: true });
  await cp(path.join(source, 'dist'), path.join(target, 'dist'), { recursive: true });
  await cp(path.join(source, 'package.json'), path.join(target, 'package.json'));

  console.log(`  node_modules/${SHARED_PACKAGE}    copied`);
}

/** Writes `app/version.json` — what this build calls itself. */
async function writeVersionFile(versions) {
  const rootManifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const migrations = await readdir(path.join(APP, 'migrations'));

  const contents = buildVersionFile({
    appVersion: appVersion(gitDescribe(), rootManifest.version),
    // Read from the migrations that were *copied into the layout*, not from the
    // repository, so the number describes the artifact rather than the checkout
    // it came from.
    schemaVersion: schemaVersionFromMigrations(migrations),
    pgMajor: pgMajorFromVersion(versions.postgresql.version),
  });

  await writeFile(path.join(APP, 'version.json'), `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  console.log(
    `  version.json              ${contents.appVersion} · schema ${contents.schemaVersion} · ` +
      `PostgreSQL ${contents.pgMajor}`,
  );
}

/** `git describe`, or null when this is not a checkout with tags. */
function gitDescribe() {
  const result = spawnSync('git', ['describe', '--tags', '--always', '--dirty'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function report(manifest) {
  banner('Layout');

  const app = await measure(APP);
  const pgsql = await measure(PGSQL);

  for (const [what, measured] of [
    ['app/', app],
    ['pgsql/', pgsql],
  ]) {
    console.log(
      `  ${what.padEnd(12)} ${String(measured.files).padStart(6)} files  ${megabytes(measured.bytes).padStart(10)}`,
    );
  }
  console.log(
    `  ${'total'.padEnd(12)} ${String(app.files + pgsql.files).padStart(6)} files  ${megabytes(app.bytes + pgsql.bytes).padStart(10)}`,
  );

  console.log(`\n  ${path.relative(ROOT, OUTPUT)}/ is assembled.`);
  console.log('  Nothing in it runs yet: there is no service, no launcher, and no installer.');
  console.log(
    `  It carries ${Object.keys(manifest.dependencies).length} pinned production dependencies.`,
  );
}

async function measure(directory) {
  let files = 0;
  let bytes = 0;

  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files += 1;
        bytes += (await stat(full)).size;
      }
    }
  };

  await walk(directory);
  return { files, bytes };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The sha256 of a file, streamed — a pinned artifact does not fit comfortably in memory. */
async function sha256OfFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function banner(title) {
  console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 62 - title.length))}`);
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function assertExists(target, what, remedy = '') {
  try {
    await stat(target);
  } catch {
    throw new Error(`Missing ${what}: ${target} does not exist.${remedy ? ` ${remedy}` : ''}`);
  }
}

/** Runs a command, inheriting stdio, and stops the build if it fails. */
function run(command, args, cwd) {
  // `shell: true` on Windows, where `npm` is `npm.cmd` and spawn will not find
  // it otherwise. The arguments are ours and contain no user input.
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(' ')}\` failed with exit code ${result.status}.`);
  }
}

main().catch((error) => {
  console.error(`\nBuild failed: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
