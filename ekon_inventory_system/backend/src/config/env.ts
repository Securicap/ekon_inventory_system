import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Loads the repository's `.env`, wherever the process happens to have been
 * started from.
 *
 * `npm run migrate` sets the working directory to the workspace, `make migrate`
 * runs from the repository root, and an editor may run a script from anywhere.
 * A junior developer should not have to know which of those they are doing, so
 * this walks up from this file looking for a `.env`.
 *
 * In production there is no `.env` at all — the platform supplies the
 * environment — so a missing file is not an error.
 */
export function loadEnvFile(): void {
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
