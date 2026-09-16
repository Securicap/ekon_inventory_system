import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * The build's identity, written by whatever produced the installation.
 *
 * An installed product has no deploy pipeline to set `APP_VERSION` and
 * `EXPECTED_SCHEMA_VERSION` in an environment: it has a directory of files that
 * were copied onto a computer in a shop, possibly months ago, possibly by
 * somebody who is no longer reachable. So the build states its own version, in
 * a file it ships with, next to the code it describes.
 *
 * That makes the two values a property of the artifact rather than of the
 * machine — which is the whole point. An upgrade replaces `Program Files\Ekon\`
 * wholesale (ADR 13), so the version file is replaced with the code, and the
 * pair can never drift. An operator editing a setting cannot accidentally tell
 * a build it is a different build.
 *
 * ```json
 * { "appVersion": "1.4.0", "schemaVersion": "0015" }
 * ```
 */
export const versionFileSchema = z
  .object({
    /** Free-form. A release name, a semver, or a commit sha — whatever built it. */
    appVersion: z.string().trim().min(1, 'appVersion must not be empty'),
    /**
     * The migration this build expects, in exactly the form the database
     * reports it: the four-digit prefix of a migration filename.
     */
    schemaVersion: z
      .string()
      .trim()
      .regex(/^\d{4}$/, 'schemaVersion must be a four-digit migration version, for example 0015'),
  })
  .strict();

export type VersionFile = z.infer<typeof versionFileSchema>;

/**
 * Reads and validates the version file at `path`.
 *
 * Every failure is fatal and says which file it was. A build that cannot state
 * its own version must not start: the alternative is an installation that
 * silently falls back to `dev` and to whatever schema pin the environment
 * happened to carry, which is exactly the state the file exists to make
 * impossible.
 */
export function readVersionFile(path: string): VersionFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `EKON_VERSION_FILE points at ${path}, which could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `EKON_VERSION_FILE ${path} is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = versionFileSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `EKON_VERSION_FILE ${path} is not a valid version file:\n${problems}\n\n` +
        'Expected {"appVersion": "<build>", "schemaVersion": "NNNN"}.',
    );
  }

  return result.data;
}
