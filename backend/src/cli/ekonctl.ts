#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from '../config/env.js';
import { loadConfig, type Config } from '../config/index.js';
import { migrateUp, migrationStatus } from '../platform/db/migrator.js';
import { createPool } from '../platform/db/pool.js';
import { AppError } from '../platform/http/errors.js';
import { assertKnownFlags, flagIsSet, flagValue, parseArgs, type ParsedArgs } from './args.js';
import { runBackup } from './commands/backup.js';
import { runDiagnostics } from './commands/diagnostics.js';
import { runRestore } from './commands/restore.js';
import { runRestoreDrill } from './commands/restoreDrill.js';
import { createInitialOwnerFromEnvironment } from './createInitialOwner.js';

/**
 * `ekon-ctl` — everything an operator does to an installation.
 *
 * Ekon Local runs on a computer in a shop (ADR 13). There is no platform
 * console, no `docker exec`, no ssh, and nobody on site who would use one. What
 * there is, is a machine that needs migrating on upgrade, backing up nightly,
 * restoring after a disaster, and explaining when something goes wrong — and
 * one command that does those things, the same way, on Windows and on a
 * developer's Linux laptop.
 *
 *     ekon-ctl migrate                      apply pending migrations
 *     ekon-ctl migrate-status               what is applied and what is not
 *     ekon-ctl create-owner                 the first owner, from the environment
 *     ekon-ctl backup [--tag <name>]        dump, checksum, prune, record
 *     ekon-ctl restore-drill <file>         prove a backup restores (throwaway db)
 *     ekon-ctl restore <file> --yes         put a backup back (keeps the old one)
 *     ekon-ctl diagnostics                  a bundle support can read
 *
 * The npm scripts that existed before this still work and still run the same
 * code: `npm run migrate` and `npm run identity:create-owner` are how a
 * developer runs these, and this is how an installation does.
 *
 * **Every subcommand loads and validates the whole configuration first.** A
 * backup that ran against a half-configured environment would be the worst
 * possible thing to discover afterwards, and `EKON_CONFIG_FILE` is how an
 * installed service points at its own settings rather than at whatever `.env`
 * happens to be near the working directory.
 */

const USAGE = `ekon-ctl — operate an Ekon installation

Usage:
  ekon-ctl migrate
  ekon-ctl migrate-status
  ekon-ctl create-owner
  ekon-ctl backup [--tag <name>]
  ekon-ctl restore-drill <file> [--allow-external]
  ekon-ctl restore <file> --yes [--allow-external] [--discard-previous <database>]
  ekon-ctl diagnostics

Commands:
  migrate          Apply every pending migration, in order, each in its own transaction.
  migrate-status   Print which migrations are applied, and which are pending.
  create-owner     Create the first OWNER. Reads EKON_OWNER_USERNAME,
                   EKON_OWNER_DISPLAY_NAME, and EKON_OWNER_PASSWORD from the
                   environment — never from arguments, which "ps" shows to everyone.
  backup           Dump the database to EKON_BACKUP_DIR, verify it, write a sha256
                   beside it, prune old copies, and record the result for the
                   system status screen. --tag marks a backup that is never pruned.
  restore-drill    Restore a backup into a throwaway database, check it, drop it.
                   An untested backup is not a backup. Refuses a file from outside
                   EKON_BACKUP_DIR unless --allow-external.
  restore          Replace the live database with a backup. Requires --yes. The
                   current database is renamed and kept, never dropped;
                   --discard-previous names an older displaced database to remove.
  diagnostics      Write a zip to EKON_STATE_DIR with the build, the schema, row
                   counts, and logs. No business data of any kind.

Configuration comes from the environment, or from the file EKON_CONFIG_FILE names.
See .env.example.
`;

type CommandHandler = (
  config: Config,
  args: ParsedArgs,
  write: (message: string) => void,
) => Promise<void>;

const COMMANDS: Record<string, { flags: readonly string[]; run: CommandHandler }> = {
  migrate: {
    flags: [],
    run: async (config, _args, write) => {
      const pool = createPool(config);
      try {
        const applied = await migrateUp(pool, undefined, write);
        write(
          applied.length > 0
            ? `Applied ${applied.length} migration(s).`
            : 'Database is up to date.',
        );
      } finally {
        await pool.end();
      }
    },
  },

  'migrate-status': {
    flags: [],
    run: async (config, _args, write) => {
      const pool = createPool(config);
      try {
        const rows = await migrationStatus(pool);
        if (rows.length === 0) {
          write('No migration files found.');
          return;
        }
        for (const row of rows) {
          const state = row.applied
            ? row.checksumMatches
              ? `applied ${row.appliedAt?.toISOString() ?? ''}`
              : 'APPLIED BUT CHECKSUM CHANGED'
            : 'pending';
          write(`${row.version}  ${row.filename.padEnd(44)}  ${state}`);
        }
      } finally {
        await pool.end();
      }
    },
  },

  'create-owner': {
    flags: [],
    // The same function `npm run identity:create-owner` calls. One
    // implementation, so the command an installer runs and the command a
    // developer runs cannot drift.
    run: async (_config, _args, write) => {
      await createInitialOwnerFromEnvironment(process.env, (message) =>
        write(message.replace(/\n$/, '')),
      );
    },
  },

  backup: {
    flags: ['tag'],
    run: async (config, args, write) => {
      await runBackup(config, { tag: flagValue(args, 'tag') }, write);
    },
  },

  'restore-drill': {
    flags: ['allow-external'],
    run: async (config, args, write) => {
      const file = requireFile(args, 'restore-drill');
      await runRestoreDrill(
        config,
        file,
        { allowExternal: flagIsSet(args, 'allow-external') },
        write,
      );
    },
  },

  restore: {
    flags: ['yes', 'allow-external', 'discard-previous'],
    run: async (config, args, write) => {
      const file = requireFile(args, 'restore');
      await runRestore(
        config,
        file,
        {
          yes: flagIsSet(args, 'yes'),
          allowExternal: flagIsSet(args, 'allow-external'),
          discardPrevious: flagValue(args, 'discard-previous'),
        },
        write,
      );
    },
  },

  diagnostics: {
    flags: [],
    run: async (config, _args, write) => {
      await runDiagnostics(config, write);
    },
  },
};

function requireFile(args: ParsedArgs, command: string): string {
  const file = args.positional[0];
  if (file === undefined) {
    throw new Error(`${command} needs the path to a backup file: ekon-ctl ${command} <file>`);
  }
  return file;
}

/**
 * Runs one subcommand. Exported so tests can drive the whole dispatcher without
 * a child process, and so nothing here reads `process.argv` except `main`.
 */
export async function runEkonCtl(
  argv: readonly string[],
  write: (message: string) => void,
): Promise<void> {
  const args = parseArgs(argv);

  if (args.command === undefined || args.command === 'help' || flagIsSet(args, 'help')) {
    write(USAGE);
    return;
  }

  const command = COMMANDS[args.command];
  if (!command) {
    throw new Error(
      `Unknown command "${args.command}". Run "ekon-ctl help" for the list of commands.`,
    );
  }

  assertKnownFlags(args, args.command, command.flags);
  await command.run(loadConfig(), args, write);
}

async function main(): Promise<void> {
  // Must run before any config is read, exactly as every other entry point
  // does. `EKON_CONFIG_FILE` is what makes an installed service read its own
  // settings rather than whatever `.env` is near the working directory.
  loadEnvFile();
  await runEkonCtl(process.argv.slice(2), (message) => process.stdout.write(`${message}\n`));
}

/**
 * Only when this file is what was executed. Importing it — which the tests do —
 * must not connect to a database, dump anything, or drop anything.
 */
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    // An operator mistake gets one clear line and its field detail. Anything
    // else is reported as itself, because it is a bug or an outage and the
    // message is the only thing anybody will have.
    if (error instanceof AppError) {
      process.stderr.write(`${error.message}\n`);
      for (const detail of error.details ?? []) {
        process.stderr.write(`  - ${detail.path}: ${detail.message}\n`);
      }
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  });
}
