import { loginRequestSchema, type AuthenticatedUser } from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import { AppError } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import { DUMMY_PASSWORD_HASH, verifyPassword } from './domain/password.js';
import {
  generateSessionToken as defaultGenerateSessionToken,
  hashSessionToken,
  type GeneratedSessionToken,
} from './domain/sessionToken.js';
import {
  findLoginUser,
  findRoleCapabilities,
  findSessionPrincipal,
  insertSessionForActiveUser,
  isUniqueViolation,
  revokeSession,
  SESSION_TOKEN_HASH_UNIQUE_CONSTRAINT,
} from './infrastructure/identityRepository.js';
import { SESSION_ABSOLUTE_LIFETIME_MS } from './sessionCookie.js';

/**
 * Authentication: establishing a session, resolving one, and ending one.
 *
 * The three operations the routes call, and the whole of what this module does
 * with sessions. It does not decide what anyone may do — no capability is
 * checked here, no route is protected, and no request is decorated with a
 * principal. `authenticate` answers "who is this?" and hands back a value; who
 * asks, and what they do with the answer, is the caller's business (and, for
 * business routes, a later PR's).
 *
 * Nothing in this file knows about cookies, headers, or status codes. It is
 * given a raw token string or null and returns a user or null; the route layer
 * is what turns those into a `Set-Cookie` and a 401.
 */

/**
 * Three attempts, then give up.
 *
 * A token hash collision means two 256-bit random values came out equal, which
 * will not happen — there is no realistic number of sessions that makes it
 * likely. The retry is here because the alternative to handling an
 * impossible-but-fatal case is a 500 that nobody can reproduce, and because the
 * cost of being wrong about "impossible" is a person who cannot sign in. Three
 * is enough for a genuine collision and small enough that a *systematic*
 * failure — a token generator wedged into returning a constant, say — surfaces
 * as an error rather than as a loop.
 *
 * Only the unique violation is retried. Any other database failure is thrown
 * on the first attempt: retrying an unknown fault is how one broken statement
 * becomes three.
 */
const MAX_SESSION_TOKEN_ATTEMPTS = 3;

export interface LoginCommand {
  /** As typed. Normalized here before it is looked up. */
  username: string;
  /** Plaintext, for the length of one verification. Never stored or logged. */
  password: string;
}

export interface LoginResult {
  user: AuthenticatedUser;
  /**
   * The one moment this value exists outside the browser. The route puts it
   * straight into a cookie; it is not returned in the response body, not
   * logged, and not written anywhere.
   */
  rawSessionToken: string;
}

export interface AuthServiceDeps {
  pool: DatabasePool;
  clock: Clock;
  /** Overridable so tests can pin the generated session id. */
  generateId?: (() => string) | undefined;
  /**
   * Overridable only for tests, which is the only way to reach the collision
   * path deliberately. Production uses the CSPRNG generator.
   */
  generateSessionToken?: (() => GeneratedSessionToken) | undefined;
}

export interface IdentityAuthService {
  login(command: LoginCommand): Promise<LoginResult>;
  /** The current user behind this token, or null. Never throws for a bad one. */
  authenticate(rawSessionToken: string | null): Promise<AuthenticatedUser | null>;
  /** Ends this one session. Succeeds whatever the token turns out to be. */
  logout(rawSessionToken: string | null): Promise<void>;
}

/**
 * The only thing a failed sign-in ever says.
 *
 * One message and one status for an unknown username, a wrong password, and a
 * deactivated account. Distinguishing them would turn the login form into a way
 * to ask which usernames exist and which of those still work — worth knowing
 * before an attack, and worth knowing to anyone curious about who has left the
 * business. The person who genuinely mistyped is not much helped by being told
 * which half they got wrong, and can try again.
 *
 * The three cases are also indistinguishable in *cost*, not only in wording:
 * an unknown username still verifies a password against a dummy hash, and a
 * deactivated user is refused only after their real hash has been checked.
 */
function invalidCredentials(): AppError {
  return new AppError('UNAUTHENTICATED', 'Invalid username or password');
}

export function createIdentityAuthService(deps: AuthServiceDeps): IdentityAuthService {
  const { pool, clock } = deps;
  const generateId = deps.generateId ?? newId;
  const generateSessionToken = deps.generateSessionToken ?? defaultGenerateSessionToken;

  async function login(command: LoginCommand): Promise<LoginResult> {
    // Parsed here as well as at the route, because the normalized username is
    // what the lookup has to use: `" Marie.J "` and `marie.j` are one account,
    // and a service that trusted its caller to have lower-cased would fail to
    // find a real user rather than failing loudly.
    const { username, password } = loginRequestSchema.parse(command);

    const user = await findLoginUser(pool, username);

    if (!user) {
      // Verify against a hash that belongs to nobody, so that an unknown
      // username costs what a real one costs. The result is discarded — it
      // cannot be true — but the work is not.
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
      throw invalidCredentials();
    }

    if (!(await verifyPassword(user.passwordHash, password))) throw invalidCredentials();

    // After the password, never before it: a deactivated account must cost the
    // same as a live one, or "is this person still employed here?" becomes a
    // question the login form answers by responding faster.
    if (!user.isActive) throw invalidCredentials();

    const rawSessionToken = await createSession(user.id);

    // Read after the session is written, so the capabilities returned are the
    // ones the very next request will resolve — not a set captured before it.
    // Nothing is stored from this: it is a read of the current mapping, and the
    // session row keeps no copy of the answer.
    const capabilities = await findRoleCapabilities(pool, user.role);

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        capabilities,
      },
      rawSessionToken,
    };
  }

  /**
   * Mints one session row for a user who has just proved who they are, and
   * returns the raw token that opens it.
   *
   * Deliberately not in a transaction. It is a single statement, and wrapping
   * the Argon2id verification above it in one would hold a connection open for
   * a tenth of a second of pure CPU per sign-in.
   */
  async function createSession(userId: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_SESSION_TOKEN_ATTEMPTS; attempt += 1) {
      const { rawToken, tokenHash } = generateSessionToken();
      const createdAt = clock.now();
      const expiresAt = new Date(createdAt.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);

      let inserted: boolean;
      try {
        inserted = await insertSessionForActiveUser(pool, {
          id: generateId(),
          userId,
          tokenHash,
          createdAt,
          expiresAt,
        });
      } catch (error) {
        if (
          isUniqueViolation(error, SESSION_TOKEN_HASH_UNIQUE_CONSTRAINT) &&
          attempt < MAX_SESSION_TOKEN_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }

      // The user was deactivated between the password check and this insert.
      // Same answer as a wrong password: they are not signing in, and the
      // reason is not the login form's to explain.
      if (!inserted) throw invalidCredentials();

      return rawToken;
    }

    // Three independent 256-bit values all collided, or something is generating
    // tokens that are not random. Either way it is a server fault, not the
    // person's, and it says nothing about their credentials.
    throw new AppError('INTERNAL', 'Could not establish a session');
  }

  async function authenticate(rawSessionToken: string | null): Promise<AuthenticatedUser | null> {
    // No cookie, or an empty one. Not an error — most requests to a public
    // route arrive this way.
    if (!rawSessionToken) return null;

    const principal = await findSessionPrincipal(
      pool,
      hashSessionToken(rawSessionToken),
      clock.now(),
    );
    if (!principal) return null;

    // Nothing is written here. The session is not extended, no last-activity
    // timestamp is stamped, and no counter moves: resolving a session is a
    // read, which is what makes the twelve hours absolute rather than sliding
    // and keeps an authenticated request to one query.
    return {
      id: principal.userId,
      username: principal.username,
      displayName: principal.displayName,
      role: principal.role,
      capabilities: principal.capabilities,
    };
  }

  async function logout(rawSessionToken: string | null): Promise<void> {
    if (!rawSessionToken) return;
    // Whatever the cookie contained — a real token, a stale one, or a string
    // somebody pasted — it becomes a digest and revokes at most the one row it
    // matches. It cannot throw, cannot match another user's session, and
    // reports nothing about what it found.
    await revokeSession(pool, hashSessionToken(rawSessionToken), clock.now());
  }

  return { login, authenticate, logout };
}
