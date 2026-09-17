/**
 * The decisions the Windows layout is assembled from, as pure functions.
 *
 * Separated from `build-layout.mjs` because they are the parts that can be
 * wrong without anything failing loudly. A download that breaks is obvious; a
 * `version.json` that says `0014` when the build carries fifteen migrations is
 * an installation that refuses to start in a shop six months later, and the
 * only place that can be caught is a test.
 *
 * Nothing here touches the filesystem, the network, or the clock. The
 * orchestrator reads the world and hands it in.
 */

/**
 * The migration filename pattern, identical to the runner's
 * (`backend/src/platform/db/migrator.ts`). Stated again rather than imported
 * because this script runs before anything is built, and a build tool that
 * needed the build to have succeeded would be no use on a broken checkout.
 *
 * The duplication is deliberate and narrow: if these two ever disagree, the
 * `schemaVersion` this writes would not match what the database reports, and
 * the application refuses to start — loudly, at boot, which is the failure mode
 * worth having.
 */
const MIGRATION_FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * The migration version a build expects: the highest four-digit prefix in
 * `backend/migrations`.
 *
 * This is the number the application compares against the database at boot
 * (`assertSchemaVersion`), so it has to be derived from the files that ship,
 * not from a constant somebody remembers to bump.
 *
 * A `.sql` file that is not a well-formed migration is an **error**, not
 * something to skip. The migration runner refuses to start against one, so a
 * build that quietly ignored it would produce an installation that fails at
 * first boot rather than at build time. Files that are not `.sql` at all —
 * a README, an editor's backup — are ignored, because they are not claiming to
 * be migrations.
 *
 * @param {readonly string[]} filenames Directory entries, in any order.
 * @returns {string} e.g. `"0015"`
 */
export function schemaVersionFromMigrations(filenames) {
  const versions = [];

  for (const filename of filenames) {
    if (!filename.endsWith('.sql')) continue;

    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) {
      throw new Error(
        `"${filename}" is in backend/migrations but is not a valid migration filename. ` +
          'Expected NNNN_lower_snake_case.sql, for example 0015_system_capability.sql.',
      );
    }

    const version = /** @type {string} */ (match[1]);
    if (versions.includes(version)) {
      throw new Error(`Two migrations share the version ${version}; renumber one of them.`);
    }
    versions.push(version);
  }

  if (versions.length === 0) {
    throw new Error(
      'No migrations found in backend/migrations. A build with no schema to pin is not a build.',
    );
  }

  // Fixed-width numeric prefixes, so lexical order is chronological order.
  return versions.sort().at(-1);
}

/**
 * The PostgreSQL major version bundled with this layout.
 *
 * Derived from the pinned artifact rather than written down twice: the whole
 * point of `versions.json` is that the version exists in exactly one place, and
 * a hard-coded `16` here would be a second answer that goes stale the day
 * somebody pins 17.
 *
 * @param {string} version e.g. `"16.15-1"`
 * @returns {number}
 */
export function pgMajorFromVersion(version) {
  const match = /^(\d+)\./.exec(String(version).trim());
  if (!match) {
    throw new Error(
      `Cannot read a PostgreSQL major version from "${version}". ` +
        'Expected something like "16.15-1" in scripts/windows/versions.json.',
    );
  }
  return Number.parseInt(/** @type {string} */ (match[1]), 10);
}

/**
 * What the build calls itself.
 *
 * `git describe` when the checkout has tags and is not a shallow clone with
 * none; the workspace version otherwise. Both are honest answers — one says
 * which release this is, the other says which line of development it came from
 * — and neither is allowed to be empty, because `appVersion` is what a support
 * conversation starts from.
 *
 * `-dirty` is kept when git reports it. A build made from a modified working
 * copy should say so, permanently, in the file that travels with it.
 *
 * @param {string | null} gitDescribe Trimmed output, or null when git failed.
 * @param {string} packageVersion `package.json`'s version.
 * @returns {string}
 */
export function appVersion(gitDescribe, packageVersion) {
  const described = gitDescribe?.trim();
  if (described !== undefined && described !== '') return described;

  const fallback = packageVersion?.trim();
  if (fallback === undefined || fallback === '') {
    throw new Error('Neither git nor package.json could say what version this build is.');
  }
  return fallback;
}

/**
 * The `version.json` that ships inside `app/`.
 *
 * Read at boot through `EKON_VERSION_FILE`: `appVersion` and `schemaVersion`
 * become the application's configuration, and an environment that disagrees
 * with them is a boot error (see `backend/src/config/versionFile.ts`). It is
 * also the first file support asks for, and `ekon-ctl diagnostics` copies it
 * into the bundle verbatim.
 *
 * @param {{ appVersion: string, schemaVersion: string, pgMajor: number }} facts
 */
export function buildVersionFile(facts) {
  return {
    appVersion: facts.appVersion,
    schemaVersion: facts.schemaVersion,
    // Which PostgreSQL the layout bundled. The application does not act on it;
    // the installer and a support conversation do — "which major is the cluster
    // in ProgramData?" is the first question any upgrade has to answer, and an
    // installed tree should not have to be guessed at from the contents of
    // `pgsql/bin`.
    pgMajor: facts.pgMajor,
  };
}

/**
 * The `package.json` that ships inside `app/`.
 *
 * Not a copy of `backend/package.json`, and the differences are all things that
 * would be wrong on a shop computer:
 *
 * - **no `devDependencies`** — `tsx`, `vitest`, and TypeScript are not
 *   installed there and nothing would run them;
 * - **no `scripts`** — every one of them invokes dev tooling that is absent, so
 *   they could only ever produce a confusing failure;
 * - **no `@ekon/shared`** — it is not on a registry. It is copied into
 *   `node_modules/@ekon/shared` directly, which is the only place Node will
 *   resolve the bare specifier from;
 * - **exact versions** rather than ranges, taken from what this repository
 *   actually has installed, so the tree that ships is the tree the tests ran
 *   against rather than whatever the ranges resolved to that afternoon.
 *
 * What it keeps is the one field that must be there: `"type": "module"`.
 * Without it Node reads `dist/*.js` as CommonJS and the process dies on the
 * first `import`.
 *
 * @param {{ name?: string, version?: string, dependencies?: Record<string, string> }} backendManifest
 * @param {(name: string) => string} installedVersion Resolves the version actually installed.
 * @param {readonly string[]} [workspaceDependencies] Deps that ship as files, not from a registry.
 */
export function buildAppManifest(backendManifest, installedVersion, workspaceDependencies = []) {
  const dependencies = {};

  for (const name of Object.keys(backendManifest.dependencies ?? {}).sort()) {
    if (workspaceDependencies.includes(name)) continue;

    const version = installedVersion(name);
    if (typeof version !== 'string' || version.trim() === '') {
      throw new Error(
        `Cannot determine the installed version of "${name}". ` +
          'Run `npm ci` before building the Windows layout.',
      );
    }
    dependencies[name] = version.trim();
  }

  if (Object.keys(dependencies).length === 0) {
    throw new Error(
      'The application manifest ended up with no dependencies, which cannot be right.',
    );
  }

  return {
    name: backendManifest.name ?? '@ekon/backend',
    version: backendManifest.version ?? '0.0.0',
    private: true,
    type: 'module',
    dependencies,
  };
}

/**
 * Which files to take out of the Node.js archive, and where to put them.
 *
 * One file. The bundled runtime is the interpreter and nothing else: no npm, no
 * corepack, no headers, no documentation. The application ships with its
 * `node_modules` already installed, so there is nothing on a shop computer that
 * would ever install a package — and shipping a package manager to a machine
 * with no internet, next to the business's records, buys exactly nothing.
 *
 * @param {string} archivePath e.g. `node-v22.23.2-win-x64/node.exe`
 * @returns {string | null} Destination relative to `app/`, or null to skip.
 */
export function selectNodeRuntimeFile(archivePath) {
  return /^node-v[\d.]+-win-x64\/node\.exe$/.test(archivePath) ? 'node.exe' : null;
}

/**
 * Which files to take out of the PostgreSQL archive, and where to put them.
 *
 * `bin`, `lib`, and `share`, with the archive's `pgsql/` prefix stripped —
 * the three directories a server needs to initialise a cluster and run.
 *
 * Everything else the EDB archive carries is deliberately dropped: `doc`,
 * `include`, `symbols`, `pgAdmin 4`. They are most of its size, none of them is
 * reachable from anything Ekon does, and a shop computer should not be carrying
 * a database GUI it was never told about.
 *
 * @param {string} archivePath e.g. `pgsql/bin/postgres.exe`
 * @returns {string | null} Destination relative to `pgsql/`, or null to skip.
 */
export function selectPostgresFile(archivePath) {
  const match = /^pgsql\/(bin|lib|share)\/(.+)$/.exec(archivePath);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
