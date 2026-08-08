import { z } from 'zod';

/**
 * A migration version is the four-digit prefix of a migration filename —
 * `NNNN_short_description.sql`. Nothing else can ever match what the database
 * reports, so `8`, `v2`, or a blank value is refused here rather than surfacing
 * at boot as a mismatch against a version that never existed.
 *
 * Only the shape is stated. Which version is current is not written down in
 * application source at all: the environment supplies it and
 * `assertSchemaVersion` compares it against the database.
 */
const expectedSchemaVersion = z
  .string({
    required_error:
      'EXPECTED_SCHEMA_VERSION is required when NODE_ENV=production. Pin the migration ' +
      'version this build expects, so a deploy cannot serve traffic against a schema it ' +
      'does not understand.',
  })
  .trim()
  .regex(/^\d{4}$/, 'must be the four-digit prefix of a migration filename, for example 0001');

/**
 * Configuration is parsed and validated once, at boot, and the process refuses
 * to start if anything required is missing or malformed. A shop in another
 * country must never discover a misconfiguration as a 500 at the counter.
 */
const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Postgres connection string. Managed providers supply this directly. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * Managed Postgres requires TLS but usually presents a certificate signed by
   * a private CA, so verification is disabled while encryption is not.
   */
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  // `silent` is used by CI and tests; pino supports it.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Directory holding the built frontend. Relative paths resolve from the
   * backend package root.
   */
  STATIC_DIR: z.string().default('./public'),

  /**
   * Refuse to serve traffic unless the database schema is at this migration.
   * Set by CI at build time. Development and test may leave it unset, which
   * skips the check; production may not — see `productionSchema` below.
   */
  EXPECTED_SCHEMA_VERSION: expectedSchemaVersion.optional(),

  /** Displayed in the health endpoint so a deploy can be identified. */
  APP_VERSION: z.string().default('dev'),

  /**
   * Every timestamp is stored in UTC and displayed in shop time, for every
   * user, everywhere — so the owner abroad and the employee at the counter
   * never read the same movement as two different dates.
   */
  DISPLAY_TIMEZONE: z.string().default('America/Port-au-Prince'),
});

/**
 * Production is stricter than development, and the difference is stated here
 * rather than as an `if (NODE_ENV === 'production')` somewhere in the
 * application. A deploy that forgot to pin its schema version must not be able
 * to boot: without a pin, `assertSchemaVersion` is never called and a build can
 * serve traffic against a database at any version at all.
 *
 * Requiring it in the schema — rather than refining the parsed result — keeps
 * the one-pass error report: a production environment missing both its database
 * url and its schema pin is told about both, in one message, before anything
 * opens a connection.
 */
const productionSchema = baseSchema.extend({
  EXPECTED_SCHEMA_VERSION: expectedSchemaVersion,
});

export type Config = z.infer<typeof baseSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Read before validation on purpose: this only chooses which rules apply, and
  // `NODE_ENV` is validated by both of them. Anything that is not exactly
  // `production` gets the development rules and is then rejected by the enum if
  // it was a typo rather than a real environment.
  const schema = env.NODE_ENV === 'production' ? productionSchema : baseSchema;
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration. Fix the environment and start again:\n${problems}\n\n` +
        'See .env.example for the full list of variables.',
    );
  }

  return parsed.data;
}
