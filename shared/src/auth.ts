import { z } from 'zod';
import { capabilitySchema, type Capability } from './capabilities.js';
import { DISPLAY_NAME_MAX_LENGTH, USERNAME_PATTERN, usernameSchema } from './identity.js';
import { roleSchema } from './roles.js';

/**
 * The authentication contracts — the wire shapes of signing in, signing out,
 * and asking the server who you are.
 *
 * Shared because the browser form, the route that parses it, and the tests that
 * assert the response all have to agree on one definition. What is deliberately
 * *not* here is anything about how a credential is checked or a session is
 * carried: no hashing algorithm, no Argon2 parameters, no cookie name, no token
 * shape, no session id. Those are server-side facts, they would tell an
 * attacker something, and nothing in the browser can act on them — the session
 * cookie is `HttpOnly`, so frontend code never sees a token at all.
 *
 * See `backend/src/modules/identity/` for everything on the other side of that
 * line.
 */

/**
 * The length bounds a login form and the login route must both apply, stated
 * here so the two cannot disagree about which passwords are even worth sending.
 * The backend's password utility takes its own bounds from these constants;
 * they are the single definition.
 *
 * They are input bounds and nothing more. There are deliberately no composition
 * requirements — no required digit, symbol, or mixed case: they add very little
 * to the search space and reliably produce `Password1!`, which is worse than
 * the four ordinary words somebody would otherwise have picked. Ten characters
 * is long enough that a passphrase is the natural way to satisfy it; the upper
 * bound is there so no hash is asked to chew through a megabyte of pasted text.
 */
export const PASSWORD_INPUT_MIN_LENGTH = 10;
export const PASSWORD_INPUT_MAX_LENGTH = 128;

/**
 * A password as typed, checked for length and nothing else.
 *
 * Never trimmed, on either side of the wire. A leading or trailing space is a
 * character the person chose, and silently removing it means the password that
 * was set is not the password that works.
 */
export const passwordInputSchema = z
  .string()
  .min(
    PASSWORD_INPUT_MIN_LENGTH,
    `Password must be at least ${PASSWORD_INPUT_MIN_LENGTH} characters`,
  )
  .max(
    PASSWORD_INPUT_MAX_LENGTH,
    `Password must be at most ${PASSWORD_INPUT_MAX_LENGTH} characters`,
  );

/**
 * `POST /api/auth/login`.
 *
 * Strict: a request carrying anything beyond these two fields is rejected
 * rather than ignored. Login is the one route where a stray field is most
 * likely to be an attempt at something — a role, a user id, a session lifetime
 * — and quietly dropping it would make the attempt indistinguishable from a
 * typo.
 *
 * The username is normalized by the shared rule, so `" Marie.J "` signs in to
 * the same account as `marie.j`.
 */
export const loginRequestSchema = z
  .object({
    username: usernameSchema,
    password: passwordInputSchema,
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Everything the browser is told about the signed-in person, and the only shape
 * in which a user is ever returned.
 *
 * What is absent is the point of it: no password hash, no session id, no
 * expiry, no active flag. The first two would be a credential in a JSON body;
 * the last two describe the session rather than the person, and no screen has a
 * use for them — an expired session is answered with a 401, not with a
 * timestamp the client is expected to check for itself.
 *
 * Capabilities travel with the user because every screen decides what to render
 * from them, and they are resolved from the user's *current* role on every
 * request. A role change or a deactivation therefore lands on the next request,
 * without rewriting a single session row.
 */
export const authenticatedUserSchema = z
  .object({
    id: z.string().uuid(),
    /** Already normalized: trimmed and lower-cased. */
    username: z.string().regex(USERNAME_PATTERN),
    displayName: z.string().min(1).max(DISPLAY_NAME_MAX_LENGTH),
    role: roleSchema,
    /**
     * Sorted, and without duplicates — asserted rather than assumed. Two
     * responses for the same person must be equal as values, so a client may
     * compare them, cache them, or diff them without first having to normalize
     * an order the server happened to return them in.
     */
    capabilities: z
      .array(capabilitySchema)
      .refine(isSortedAndUnique, 'Capabilities must be sorted and free of duplicates'),
  })
  .strict();

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

/**
 * The body of a successful `POST /api/auth/login` and of `GET /api/auth/me`.
 *
 * Wrapped in `user` rather than returned bare, so that a later addition — a
 * server time, a policy flag — is a new key beside it instead of a change to
 * the shape every client already parses.
 *
 * `POST /api/auth/logout` has no body at all: it answers 204.
 */
export const authenticatedUserResponseSchema = z.object({ user: authenticatedUserSchema }).strict();

export type AuthenticatedUserResponse = z.infer<typeof authenticatedUserResponseSchema>;

function isSortedAndUnique(capabilities: readonly Capability[]): boolean {
  for (let index = 1; index < capabilities.length; index += 1) {
    const previous = capabilities[index - 1];
    const current = capabilities[index];
    if (previous === undefined || current === undefined || previous >= current) return false;
  }
  return true;
}
