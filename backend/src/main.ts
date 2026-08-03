import { loadEnvFile } from './config/env.js';
import { buildApp } from './app.js';
import { loadConfig } from './config/index.js';
import { systemClock } from './platform/clock/index.js';
import { assertSchemaVersion } from './platform/db/migrator.js';
import { createPool } from './platform/db/pool.js';

// Must run before any config is read. ESM imports hoist, so this is the
// first executable statement in the process.
loadEnvFile();

/**
 * Composition root. The only place that reads the environment, opens the pool,
 * and binds a socket.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  // Fail fast on a database that is unreachable or at the wrong schema version.
  // A half-deployed instance must not accept a single inventory write.
  await pool.query('SELECT 1');
  if (config.EXPECTED_SCHEMA_VERSION) {
    await assertSchemaVersion(pool, config.EXPECTED_SCHEMA_VERSION);
  }

  const app = await buildApp({ config, pool, clock: systemClock });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so this one place uses console directly.
  // eslint-disable-next-line no-console
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
