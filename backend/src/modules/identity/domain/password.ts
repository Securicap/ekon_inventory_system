import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_INPUT_MAX_LENGTH, PASSWORD_INPUT_MIN_LENGTH } from '@ekon/shared';
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
 * The two length bounds, taken from `@ekon/shared` rather than restated.
 *
 * A login form applies them before sending, and the login route applies them
 * again on arrival, so they have to be one definition or they will eventually
 * be two disagreeing ones — the failure mode being a password a person can set
 * but not type into the form that signs them in. Ten characters, long enough
 * that a passphrase is the natural way to satisfy it; an upper bound so no hash
 * is asked to chew through a megabyte of pasted text. No composition rules; the
 * reasoning is with the constants.
 *
 * Only the numbers are shared. Nothing about hashing crosses that line.
 */
export const PASSWORD_MIN_LENGTH = PASSWORD_INPUT_MIN_LENGTH;
export const PASSWORD_MAX_LENGTH = PASSWORD_INPUT_MAX_LENGTH;

/**
 * A real Argon2id hash of a random string nobody kept, so that a login attempt
 * for a username that does not exist can still do the work of verifying a
 * password against it.
 *
 * Without it, an unknown username returns as fast as a database lookup and a
 * known one takes however long Argon2id takes — a difference an attacker can
 * measure over the internet, and the whole point of answering both with the
 * same message would be lost. It is a constant, generated once and pasted here,
 * because generating one per request would put the cost on the wrong side: the
 * hash would be *made* for the unknown user and merely *read* for the real one.
 *
 * This is not a credential. No plaintext produces it that anyone knows, it
 * grants nothing if verified, and it is deliberately not a row in `users` —
 * a dummy user would be a real account with a real role that someone could one
 * day sign in as.
 *
 * The timing claim is a modest one: an unknown username is not *trivially*
 * distinguishable from a real one. It is not constant time, and nothing here
 * pretends it is — the database lookup, the network, and the scheduler all
 * still vary.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$4kh7yw2RAF/2SU7W0fLERg$NHDsGUM+xd2mfyfecir2X3sHKpNDyLDNlrB70GoMra0';

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
