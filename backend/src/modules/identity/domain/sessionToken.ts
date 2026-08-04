import { createHash, randomBytes } from 'node:crypto';

/**
 * The session token: what the browser holds, and what the database holds
 * instead.
 *
 * The token is an opaque random string and nothing else. It is not a UUID, not
 * a JWT, and not an encrypted payload — it says nothing about who the person
 * is, what they may do, or when the session ends, because every one of those
 * questions is answered from the `sessions` and `users` rows at the moment a
 * request arrives. A token that carried answers would keep giving the old ones
 * after a role change, a deactivation, or a sign-out.
 *
 * Possession of the token *is* the credential, so it is treated like one: it is
 * never stored, never logged, never returned in JSON, never put in an error,
 * and never readable by frontend JavaScript. The database stores only its
 * SHA-256 digest, so a leaked backup yields nothing that can be presented to
 * the server.
 *
 * No cryptography is implemented here. It draws from the platform CSPRNG and
 * hashes with the platform's SHA-256; that is the entire surface.
 */

/**
 * 32 bytes — 256 bits of entropy, from `crypto.randomBytes`. Guessing one is
 * not a threat model, which is why there is no rate limiting on presenting a
 * cookie.
 *
 * base64url because the result has to live in a cookie value: 43 characters of
 * `A-Z a-z 0-9 - _`, none of which needs quoting or escaping, so the token that
 * comes back is byte-for-byte the token that went out.
 */
export const SESSION_TOKEN_BYTES = 32;

export interface GeneratedSessionToken {
  /** Goes to the browser, in the cookie. Never anywhere else. */
  rawToken: string;
  /** Goes to the database. Lowercase 64-character hex. */
  tokenHash: string;
}

export function generateSessionToken(): GeneratedSessionToken {
  const rawToken = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  return { rawToken, tokenHash: hashSessionToken(rawToken) };
}

/**
 * The one way a token becomes a database lookup key.
 *
 * SHA-256, not Argon2id, and deliberately: this is a 256-bit random string, not
 * a password. There is no dictionary to attack and no user-chosen structure to
 * exploit, so the slow hash would buy nothing and would put a several-hundred-
 * millisecond cost on every authenticated request.
 *
 * Takes any string, including whatever arbitrary bytes arrive in a cookie
 * header. A digest is computed and looked up; a garbage value simply matches no
 * row. Nothing here parses, validates, or trusts the input, so there is nothing
 * for a malformed cookie to break.
 */
export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}
