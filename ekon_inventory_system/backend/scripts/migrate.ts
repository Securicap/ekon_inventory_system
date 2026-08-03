import { loadEnvFile } from '../src/config/env.js';
import { loadConfig } from '../src/config/index.js';
import { migrateUp, migrationStatus } from '../src/platform/db/migrator.js';
import { createPool } from '../src/platform/db/pool.js';

// Must run before any config is read. ESM imports hoist, so this is the
// first executable statement in the process.
loadEnvFile();

/**
 * Applies pending migrations, or prints their status.
 *
 * In production this runs as the deploy's release command, before the new
 * instance takes traffic. A failure aborts the deploy and the previous
 * instance keeps serving.
 *
 *   npm run migrate            -- apply everything pending
 *   npm run migrate:status     -- show what is applied and what is not
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const config = loadConfig();
  const pool = createPool(config);

  try {
    if (command === 'status') {
      const rows = await migrationStatus(pool);
      if (rows.length === 0) {
        process.stdout.write('No migration files found.\n');
        return;
      }
      for (const row of rows) {
        const state = row.applied
          ? row.checksumMatches
            ? `applied ${row.appliedAt?.toISOString() ?? ''}`
            : 'APPLIED BUT CHECKSUM CHANGED'
          : 'pending';
        process.stdout.write(`${row.version}  ${row.filename.padEnd(44)}  ${state}\n`);
      }
      return;
    }

    if (command !== 'up') {
      throw new Error(`Unknown command "${command}". Use "up" or "status".`);
    }

    const applied = await migrateUp(pool, undefined, (message) =>
      process.stdout.write(`${message}\n`),
    );
    process.stdout.write(
      applied.length > 0
        ? `Applied ${applied.length} migration(s).\n`
        : 'Database is up to date.\n',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
