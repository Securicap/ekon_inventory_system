import { hash, verify } from '@node-rs/argon2';
import { AppError } from '../../../platform/http/errors.js';

/**
 * Password hashing, and the plaintext rules that guard it.
 *
 * Argon2id, through `@node-rs/argon2`, at the library's own defaults — memory
 * cost 19 MiB, two iterations, one lane, which is the OWASP recommendation for
 * Argon2id at the time of writing. The parameters are deliberately not restated
 * here: pinning numbers we did not derive would freeze this at today's hardware
 * and make a library upgrade a silent downgrade. If a constraint ever forces
 * explicit values, the reason belongs in a comment next to them.
 *
 * No cryptography is implemented in this file, and none should be. It hashes,
 * it verifies, it enforces two length bounds. That is the entire surface.
 *
 * A password never leaves this module in any form but a hash: it is not logged,
 * not put in an error message, and not attached to an error's details. The
 * caller that has the plaintext is responsible for not doing those things
 * either.
 */

/**
 * Ten characters. Long enough that a passphrase is the natural way to satisfy
 * it, short enough that nobody writes it on a sticky note.
 *
 * There are deliberately no composition requirements — no required digit,
 * symbol, or mixed case. They add very little to the search space and reliably
 * produce `Password1!`, which is worse than the four ordinary words somebody
 * would otherwise have picked.
 */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * An upper bound so that a hash is never asked to chew through a megabyte of
 * pasted text. Well above anything a person types.
 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Passwords are never trimmed. A leading or trailing space is a character the
 * person chose, and silently removing it means the password that was set is not
 * the password that works.
 */
export function assertPasswordAcceptable(password: string): void {
  // Counted the way `String.length` counts, which is what a browser form and
  // its `maxlength` attribute will report, so client and server agree.
  const length = password.length;

  if (length < PASSWORD_MIN_LENGTH) {
    throw new AppError('VALIDATION_FAILED', 'Password is too short', [
      { path: 'password', message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` },
    ]);
  }

  if (length > PASSWORD_MAX_LENGTH) {
    throw new AppError('VALIDATION_FAILED', 'Password is too long', [
      { path: 'password', message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters` },
    ]);
  }
}

/**
 * Hashes an acceptable password, returning an Argon2id PHC string
 * (`$argon2id$v=19$m=...`). The salt is generated per call, so hashing the same
 * password twice yields two different strings.
 *
 * The length rules are applied here as well as by the caller: this is the only
 * function that produces a stored credential, so it is the right place to make
 * "no password below the minimum was ever hashed" true rather than customary.
 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return hash(password);
}

/**
 * True when `password` is the one `passwordHash` was made from.
 *
 * The length rules are deliberately *not* applied. Whether a stored credential
 * still satisfies today's policy is a question for the login path, which can
 * ask the person to choose a new one; refusing to even check would lock out
 * every account that predates a tightened rule.
 *
 * Fails closed. A stored value that Argon2 cannot parse — truncated, corrupted,
 * or written by something that had no business writing it — verifies as false
 * rather than raising, so a damaged row can never be talked into granting
 * access.
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
