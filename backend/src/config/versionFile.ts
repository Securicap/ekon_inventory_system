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
 * { "appVersion": "1.4.0", "schemaVersion": "0015", "pgMajor": 16 }
 * ```
 *
 * Written by `scripts/windows/build-layout.mjs`, which derives every field from
 * the artifact it is assembling rather than from anything written down twice.
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
    /**
     * The major version of the PostgreSQL the installer bundled.
     *
     * **The application does not act on it**, and deliberately does not: which
     * server the cluster is running is the server's business, and a build that
     * refused to start because it disagreed would be inventing a second opinion
     * about a fact it can read from the connection.
     *
     * It is here because the file is the artifact's identity, and the identity
     * of an installed product includes which database it brought with it. An
     * upgrade has to know whether the cluster in `ProgramData` needs a major
     * upgrade before the new build touches it, and a support conversation
     * should not have to guess it from the contents of `pgsql\bin`.
     * `ekon-ctl diagnostics` copies this file into the bundle verbatim.
     *
     * Optional because a hosted deployment bundles no PostgreSQL at all, and a
     * container that had to state a major version it does not own would be
     * stating a fiction.
     */
    pgMajor: z.number().int().min(1).optional(),
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
