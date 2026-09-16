import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Loads the configuration file this process should read, wherever the process
 * happens to have been started from.
 *
 * Two cases, and they are genuinely different machines.
 *
 * **An installation names its file.** `EKON_CONFIG_FILE` is set by the service
 * definition to the installation's own settings — `ProgramData\Ekon\config\`,
 * not the directory the application was copied into (ADR 13). An upgrade
 * replaces the application directory wholesale, so a `.env` living next to the
 * code would be deleted by the next version; and the working directory of a
 * Windows service is not something anybody should have to reason about.
 *
 * **A developer does not.** `npm run migrate` sets the working directory to the
 * workspace, `make migrate` runs from the repository root, and an editor may
 * run a script from anywhere. A junior developer should not have to know which
 * of those they are doing, so this walks up from this file looking for a `.env`.
 *
 * A missing `.env` is not an error — CI and a container supply the environment
 * directly. A missing `EKON_CONFIG_FILE` *is* one: somebody named a file, and
 * starting anyway would mean booting with whatever happened to be in the
 * environment instead of the settings that were meant to apply.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): void {
  const named = env.EKON_CONFIG_FILE?.trim();

  if (named !== undefined && named !== '') {
    if (!existsSync(named)) {
      throw new Error(
        `EKON_CONFIG_FILE points at ${named}, which does not exist. ` +
          'Starting without it would use whatever is already in the environment rather ' +
          "than this installation's settings.",
      );
    }
    dotenv.config({ path: named, quiet: true });
    return;
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate, quiet: true });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
