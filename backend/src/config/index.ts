import { deploymentProfileSchema, type DeploymentProfile } from '@ekon/shared';
import { z } from 'zod';
import { readVersionFile } from './versionFile.js';

/**
 * A migration version is the four-digit prefix of a migration filename —
 * `NNNN_short_description.sql`. Nothing else can ever match what the database
 * reports, so `8`, `v2`, or a blank value is refused here rather than surfacing
 * at boot as a mismatch against a version that never existed.
 *
 * Only the shape is stated. Which version is current is not written down in
 * application source at all: the environment or the version file supplies it
 * and `assertSchemaVersion` compares it against the database.
 */
const expectedSchemaVersion = z
  .string({
    required_error:
      'EXPECTED_SCHEMA_VERSION is required under DEPLOYMENT_PROFILE=local and =hosted, and ' +
      'when NODE_ENV=production. Pin the migration version this build expects, so an ' +
      'installation cannot serve traffic against a schema it does not understand. An ' +
      'installed product normally supplies it through EKON_VERSION_FILE instead.',
  })
  .trim()
  .regex(/^\d{4}$/, 'must be the four-digit prefix of a migration filename, for example 0001');

const requiredDirectory = (variable: string, why: string) =>
  z
    .string({ required_error: `${variable} is required under DEPLOYMENT_PROFILE=local. ${why}` })
    .trim()
    .min(1, `${variable} must not be blank`);

/**
 * A boolean the environment can express. `true` or `false`, spelled out, and
 * nothing else — not `1`, not `yes`, not `on`. A value that is almost a boolean
 * is the one that gets read as `true` by one library and `false` by the next.
 */
const booleanFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * Configuration is parsed and validated once, at boot, and the process refuses
 * to start if anything required is missing or malformed. A shop in another
 * country must never discover a misconfiguration as a 500 at the counter.
 */
const baseSchema = z.object({
  /**
   * **What kind of installation this is**, which is a different question from
   * `NODE_ENV` and is why both exist.
   *
   * `NODE_ENV` says how the code was built and how it logs — Node's own
   * vocabulary, understood by every library in the dependency tree. This says
   * where the thing is running and therefore which safety rules apply:
   *
   * - `development` — a developer's machine. The permissive defaults.
   * - `hosted` — behind a reverse proxy that terminates TLS, on a network. The
   *   behaviour this application had before ADR 13, kept because nothing in
   *   that decision forecloses hosting later.
   * - `local` — installed on the shop computer, which is the production target.
   *   Both tiers bind to loopback, there is no proxy and no TLS in front of the
   *   process, and the state and backup directories are real places on a real
   *   disk that must be configured or the installation cannot protect itself.
   *
   * Deriving these from `NODE_ENV=production` was the alternative, and it
   * conflates two facts that now genuinely differ: a local installation is
   * production *and* speaks plain HTTP to a browser on the same machine. A
   * single flag cannot say both, and the version that tried would have to set
   * `Secure` on a cookie no browser would then keep.
   */
  DEPLOYMENT_PROFILE: deploymentProfileSchema.default('development'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Postgres connection string. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * TLS to PostgreSQL. A managed database requires it and usually presents a
   * certificate signed by a private CA, so verification is disabled while
   * encryption is not. A local installation talks to a database on the same
   * machine over loopback and defaults to `false`.
   */
  DATABASE_SSL: booleanFlag,

  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /**
   * How long to keep trying to reach the database at startup before giving up.
   *
   * An installed product starts two services at once and does not get to say
   * which finishes first: Windows brings up Ekon and Ekon PostgreSQL together,
   * and on the shop's hardware the database can take twenty seconds to open its
   * socket. Failing at the first refused connection would mean a service that
   * is down every morning until somebody restarts it, and nobody on site knows
   * how.
   */
  DATABASE_WAIT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(60_000),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * Which interface to bind. `127.0.0.1` under `local`: nothing Ekon installs
   * is reachable from the shop's network or from the internet (ADR 13, point
   * 4).
   */
  HOST: z.string(),

  // `silent` is used by CI and tests; pino supports it.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Adds `Secure` to the session cookie, so the browser will only send it back
   * over TLS.
   *
   * An explicit setting rather than `NODE_ENV === 'production'`, because the
   * production target is now a browser talking to `http://127.0.0.1` on the
   * same computer. A `Secure` cookie on that origin is dropped by the browser
   * silently — no error, no warning, and nobody can sign in — so the one place
   * this is decided is here, where an installation can state the truth about
   * its own origin.
   *
   * `true` under `hosted`, where TLS is terminated in front of the application.
   */
  SESSION_COOKIE_SECURE: booleanFlag,

  /**
   * Directory holding the built frontend. Relative paths resolve from the
   * backend package root.
   */
  STATIC_DIR: z.string().default('./public'),

  /**
   * Refuse to serve traffic unless the database schema is at this migration.
   * Required under `local` and `hosted` (and under `NODE_ENV=production`);
   * development and test may leave it unset, which skips the check.
   */
  EXPECTED_SCHEMA_VERSION: expectedSchemaVersion.optional(),

  /** Displayed in the health endpoint so a build can be identified. */
  APP_VERSION: z.string().default('dev'),

  /**
   * Every timestamp is stored in UTC and displayed in shop time, for every
   * user, everywhere — so the owner abroad and the employee at the counter
   * never read the same movement as two different dates.
   */
  DISPLAY_TIMEZONE: z.string().default('America/Port-au-Prince'),

  /**
   * An alternative path for the `.env` this process reads. Consumed by
   * `loadEnvFile` before any of this is parsed; declared here so the variable
   * is documented in one list with the rest and so a typo in its *name* is
   * visible as an unknown variable rather than as silence.
   */
  EKON_CONFIG_FILE: z.string().optional(),

  /** `{ "appVersion": "...", "schemaVersion": "NNNN" }`. See `versionFile.ts`. */
  EKON_VERSION_FILE: z.string().optional(),

  /**
   * Directory holding `pg_dump`, `pg_restore`, and `psql`.
   *
   * An installation bundles its own PostgreSQL and must use *that* one's
   * tools: a dump taken by a client older than the server is refused, and one
   * taken by a newer client may not restore into it. Unset means "whatever is
   * on PATH", which is what a developer's machine has.
   */
  EKON_PG_BIN: z.string().optional(),

  /** Where backups are written. Required under `local`. */
  EKON_BACKUP_DIR: z.string().optional(),

  /**
   * Where the installation keeps state it wrote itself rather than data the
   * business entered: the record of the last backup, diagnostics bundles.
   * Required under `local`.
   */
  EKON_STATE_DIR: z.string().optional(),

  /**
   * Retention. One backup is kept for each of the most recent
   * `BACKUP_KEEP_DAILY` days that has one, and for each of the most recent
   * `BACKUP_KEEP_WEEKLY` ISO weeks. A tagged backup is never pruned.
   */
  BACKUP_KEEP_DAILY: z.coerce.number().int().min(1).max(3650).default(14),
  BACKUP_KEEP_WEEKLY: z.coerce.number().int().min(0).max(520).default(8),
});

/**
 * Defaults that differ by profile, in one table rather than as conditionals
 * spread through the schema.
 *
 * They are applied *before* validation, to variables the environment left
 * unset, so every one of them stays overridable and every one of them is
 * validated by the same rule whatever it came from.
 */
const PROFILE_DEFAULTS: Readonly<Record<DeploymentProfile, Readonly<Record<string, string>>>> = {
  development: {
    HOST: '0.0.0.0',
    SESSION_COOKIE_SECURE: 'false',
    DATABASE_SSL: 'false',
  },
  hosted: {
    HOST: '0.0.0.0',
    SESSION_COOKIE_SECURE: 'true',
    DATABASE_SSL: 'false',
  },
  local: {
    HOST: '127.0.0.1',
    SESSION_COOKIE_SECURE: 'false',
    DATABASE_SSL: 'false',
  },
};

/**
 * `local` and `hosted` are stricter than `development`, and the difference is
 * stated here rather than as an `if (profile === 'local')` somewhere in the
 * application.
 *
 * An installation that forgot to pin its schema version must not be able to
 * boot: without a pin, `assertSchemaVersion` is never called and a build can
 * serve traffic against a database at any version at all. One that forgot where
 * to put its backups must not be able to boot either — an installation is not
 * fit to hold real inventory until backup works (ADR 13, point 6), and a
 * missing directory would be discovered the night the first backup did not run.
 *
 * Requiring them in the schema — rather than refining the parsed result — keeps
 * the one-pass error report: an installation missing its database url, its
 * schema pin, and its backup directory is told about all three, in one message,
 * before anything opens a connection.
 */
const localSchema = baseSchema.extend({
  EXPECTED_SCHEMA_VERSION: expectedSchemaVersion,
  EKON_BACKUP_DIR: requiredDirectory(
    'EKON_BACKUP_DIR',
    'An installation with nowhere to write a backup is one outage away from losing the ' +
      "business's records.",
  ),
  EKON_STATE_DIR: requiredDirectory(
    'EKON_STATE_DIR',
    'The record of the last backup and the diagnostics bundle are written there.',
  ),
});

const pinnedSchemaSchema = baseSchema.extend({
  EXPECTED_SCHEMA_VERSION: expectedSchemaVersion,
});

/**
 * The validated environment, plus the one value that is derived from it rather
 * than read.
 */
export type Config = z.infer<typeof baseSchema> & {
  /**
   * Whether to believe `X-Forwarded-For` and `X-Forwarded-Proto`.
   *
   * True only under `hosted`, where a reverse proxy terminates TLS and rewrites
   * them. A local installation has no proxy in front of it (ADR 13, point 2),
   * so a forwarded header there can only have come from the caller — trusting
   * it would let anyone on the machine choose the client address that lands in
   * the logs, and would buy nothing in exchange.
   *
   * Derived rather than configurable on purpose: it is a fact about the
   * topology, and the topology is what the profile names.
   */
  readonly TRUST_PROXY: boolean;
};

/**
 * Applies `PROFILE_DEFAULTS` to anything the environment left unset.
 *
 * Present-but-empty counts as unset: `FOO=$UNDEFINED` in a shell script and a
 * blank line in a generated `.env` both arrive as `''`, and neither is somebody
 * choosing an empty host.
 */
function withProfileDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Read before validation on purpose: this only chooses which defaults apply,
  // and `DEPLOYMENT_PROFILE` is validated by the schema either way. An
  // unrecognized value gets the development defaults so that the schema's
  // report is the one thing that is actually wrong — the profile — rather than
  // that plus every variable whose default was never applied.
  const profile = env.DEPLOYMENT_PROFILE ?? 'development';
  const defaults = PROFILE_DEFAULTS[profile as DeploymentProfile] ?? PROFILE_DEFAULTS.development;

  const prepared: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(defaults)) {
    const current = prepared[name];
    if (current === undefined || current.trim() === '') prepared[name] = value;
  }
  return prepared;
}

/**
 * Folds the version file into the environment, and refuses a disagreement.
 *
 * The file wins because it ships with the code it describes. An environment
 * that states a *different* version is not a preference to be resolved — it is
 * two answers to "which build is this", and one of them is wrong. Booting on
 * either would mean an installation reporting a version it is not running, or
 * refusing to start against a schema that is actually correct, and the person
 * who has to work out which is standing in a shop.
 */
function withVersionFile(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = env.EKON_VERSION_FILE?.trim();
  if (!path) return env;

  const version = readVersionFile(path);
  const disagreements: string[] = [];

  const stated = env.APP_VERSION?.trim();
  if (stated !== undefined && stated !== '' && stated !== version.appVersion) {
    disagreements.push(
      `APP_VERSION is "${stated}" but ${path} says "${version.appVersion}". ` +
        'Remove APP_VERSION from the environment; the build states its own version.',
    );
  }

  const pinned = env.EXPECTED_SCHEMA_VERSION?.trim();
  if (pinned !== undefined && pinned !== '' && pinned !== version.schemaVersion) {
    disagreements.push(
      `EXPECTED_SCHEMA_VERSION is "${pinned}" but ${path} says "${version.schemaVersion}". ` +
        'Remove EXPECTED_SCHEMA_VERSION from the environment; the build states its own schema.',
    );
  }

  if (disagreements.length > 0) {
    throw new Error(
      `The environment and the version file disagree about this build:\n${disagreements
        .map((line) => `  - ${line}`)
        .join('\n')}`,
    );
  }

  return {
    ...env,
    APP_VERSION: version.appVersion,
    EXPECTED_SCHEMA_VERSION: version.schemaVersion,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prepared = withProfileDefaults(withVersionFile(env));

  // `local` and `hosted` are installations; so is anything that calls itself
  // `NODE_ENV=production`, whatever profile it claims. All three must pin their
  // schema; `local` additionally has to say where it keeps its own files.
  const schema =
    prepared.DEPLOYMENT_PROFILE === 'local'
      ? localSchema
      : prepared.DEPLOYMENT_PROFILE === 'hosted' || prepared.NODE_ENV === 'production'
        ? pinnedSchemaSchema
        : baseSchema;

  const parsed = schema.safeParse(prepared);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration. Fix the environment and start again:\n${problems}\n\n` +
        'See .env.example for the full list of variables.',
    );
  }

  return { ...parsed.data, TRUST_PROXY: parsed.data.DEPLOYMENT_PROFILE === 'hosted' };
}
