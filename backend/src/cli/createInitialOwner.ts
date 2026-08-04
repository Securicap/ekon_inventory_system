import { pathToFileURL } from 'node:url';
import { loadEnvFile } from '../config/env.js';
import { loadConfig } from '../config/index.js';
import { systemClock } from '../platform/clock/index.js';
import { createPool } from '../platform/db/pool.js';
import { AppError } from '../platform/http/errors.js';
import {
  createIdentityBootstrapService,
  type CreateInitialOwnerInput,
} from '../modules/identity/index.js';

/**
 * Creates the first owner account, once, on a new installation.
 *
 *   npm run identity:create-owner
 *
 * A fresh database has no users, so there is nobody who could be authorized to
 * create one. This command is the way out of that, and it is deliberately the
 * *only* way: it refuses if an active owner already exists, there is no force
 * flag, and it cannot create a second account. Everyone after the first owner is
 * created through the signed-in identity workflow.
 *
 * Nothing is seeded by a migration, so no credential — not even a default one —
 * exists in this repository or in any environment that has not been deliberately
 * provisioned.
 */

export const OWNER_ENV_VARS = {
  username: 'EKON_OWNER_USERNAME',
  displayName: 'EKON_OWNER_DISPLAY_NAME',
  password: 'EKON_OWNER_PASSWORD',
} as const;

/**
 * Reads the three required values from the process environment.
 *
 * Environment rather than command-line arguments, for one reason that matters:
 * `ps` shows every process's arguments to every user on the machine, so a
 * password passed as `--password` is readable by anyone with a shell there while
 * the command runs, and lands in the operator's shell history besides. The
 * environment of a process is not world-readable in the same way.
 *
 * It is still not private — see the README for how to keep the value out of
 * shell history and out of `.env`.
 */
export function readOwnerInputFromEnv(env: NodeJS.ProcessEnv): CreateInitialOwnerInput {
  const missing = Object.values(OWNER_ENV_VARS).filter((name) => {
    const value = env[name];
    // Present-but-empty is a mistake, not a choice: it is what an unset shell
    // variable expands to.
    return value === undefined || value.length === 0;
  });

  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Missing required environment variable(s): ${missing.join(', ')}`,
      missing.map((name) => ({ path: name, message: 'is required' })),
    );
  }

  return {
    username: env[OWNER_ENV_VARS.username] as string,
    displayName: env[OWNER_ENV_VARS.displayName] as string,
    // Never trimmed. A leading or trailing space is a character the person chose.
    password: env[OWNER_ENV_VARS.password] as string,
  };
}

/**
 * The whole command: read the environment, open the normal application
 * database connection, create the owner, report it.
 *
 * `write` is injected so the caller decides where output goes, and so this
 * function has no opinion about `process.stdout`.
 */
export async function createInitialOwnerFromEnvironment(
  env: NodeJS.ProcessEnv,
  write: (message: string) => void,
): Promise<void> {
  const input = readOwnerInputFromEnv(env);
  const config = loadConfig(env);
  const pool = createPool(config);

  try {
    const service = createIdentityBootstrapService({ pool, clock: systemClock });
    const owner = await service.createInitialOwner(input);
    // The username and display name only. No password, no hash, no id-bearing
    // dump of the row that a log aggregator might keep for a year.
    write(`Created initial OWNER "${owner.username}" (${owner.displayName}).\n`);
  } finally {
    await pool.end();
  }
}

/**
 * True for a failure the operator caused and can fix: a missing variable, a
 * username that breaks the rules, a password that is too short, an owner that
 * already exists. These get one clear line. Anything else is a bug or an
 * outage, and is reported as itself.
 */
function isOperatorMistake(error: unknown): error is AppError {
  return error instanceof AppError;
}

async function main(): Promise<void> {
  // Must run before any config is read, exactly as the migration script does.
  loadEnvFile();
  await createInitialOwnerFromEnvironment(process.env, (message) => process.stdout.write(message));
}

// Only when this file is what was executed. Importing it — which the tests do,
// for `readOwnerInputFromEnv` — must not connect to a database or create a user.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    if (isOperatorMistake(error)) {
      process.stderr.write(`${error.message}\n`);
      for (const detail of error.details ?? []) {
        process.stderr.write(`  - ${detail.path}: ${detail.message}\n`);
      }
    } else {
      // An unexpected failure: the message, and nothing reconstructed from the
      // input that produced it.
      process.stderr.write(
        `Failed to create the initial owner: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exit(1);
  });
}
