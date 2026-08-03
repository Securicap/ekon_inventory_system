import { z } from 'zod';

/**
 * Configuration is parsed and validated once, at boot, and the process refuses
 * to start if anything required is missing or malformed. A shop in another
 * country must never discover a misconfiguration as a 500 at the counter.
 */
const configSchema = z.object({
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
   * Set by CI at build time; leaving it unset skips the check (development
   * only — production deploys should always pin it).
   */
  EXPECTED_SCHEMA_VERSION: z.string().optional(),

  /** Displayed in the health endpoint so a deploy can be identified. */
  APP_VERSION: z.string().default('dev'),

  /**
   * Every timestamp is stored in UTC and displayed in shop time, for every
   * user, everywhere — so the owner abroad and the employee at the counter
   * never read the same movement as two different dates.
   */
  DISPLAY_TIMEZONE: z.string().default('America/Port-au-Prince'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);

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
