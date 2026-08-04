import { z } from 'zod';

/**
 * Identity contracts — how a person is named to the system.
 *
 * Shared because the same two rules have to hold in three places that cannot be
 * allowed to disagree: the browser form that will create a user, the server
 * that stores one, and the database CHECK constraints that are the last line of
 * defence. A test compares the pattern below against the constraint in
 * migration 0007, so the two cannot drift apart.
 *
 * Password *hashing* is deliberately not here, or anywhere else in this
 * package. It is a server concern with a native dependency, and nothing in the
 * browser needs to know the algorithm, its parameters, or the encoded form; it
 * lives in the backend identity module. The two input-length bounds a login
 * form has to apply are in `auth.ts`, next to the login contract that uses
 * them.
 */

/**
 * A username is an identifier, not a display name — that is what
 * `display_name` is for. It is short, unambiguous when read off a screen or
 * spoken across a counter, and safe to put in a URL or a log line without
 * quoting.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 40;

/**
 * The one rule for a stored username: lowercase letters, digits, period,
 * underscore, hyphen. Deliberately narrow.
 *
 * Usernames are stored already normalized — trimmed and lower-cased — rather
 * than compared case-insensitively at read time. `citext` would have made
 * `Marie` and `marie` the same login while still storing two different-looking
 * strings; storing one canonical form means what is in the row is what the
 * system means, and a duplicate is caught by an ordinary UNIQUE constraint.
 * There is no separate "display case" of a username to keep in step.
 */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;

/** Trimmed and lower-cased: the canonical stored form of a username. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Parses a username as typed and yields its normalized form. `" Marie.J "` and
 * `"marie.j"` are the same account, and both are stored as `marie.j`.
 */
export const usernameSchema = z
  .string()
  .transform(normalizeUsername)
  .pipe(
    z
      .string()
      .min(USERNAME_MIN_LENGTH, `Username must be at least ${USERNAME_MIN_LENGTH} characters`)
      .max(USERNAME_MAX_LENGTH, `Username must be at most ${USERNAME_MAX_LENGTH} characters`)
      .regex(
        USERNAME_PATTERN,
        'Username may contain only lowercase letters, numbers, period, underscore, and hyphen',
      ),
  );

/** The name shown on screen. Free text, trimmed and bounded; case preserved. */
export const DISPLAY_NAME_MAX_LENGTH = 120;

export const displayNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, 'Display name is required')
      .max(
        DISPLAY_NAME_MAX_LENGTH,
        `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
      ),
  );
