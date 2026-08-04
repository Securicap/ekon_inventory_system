import type { Role } from '@ekon/shared';
import { generateSessionToken } from '../../src/modules/identity/domain/sessionToken.js';
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_COOKIE_NAME,
} from '../../src/modules/identity/sessionCookie.js';
import type { DatabasePool } from '../../src/platform/db/pool.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestUser, type TestUser } from './identityFixtures.js';

/**
 * A signed-in person, for the tests of everything that is not signing in.
 *
 * Every business route is now capability-protected, so a catalog or inventory
 * test has to arrive with a session. Getting one through `POST /api/auth/login`
 * would mean an Argon2id verification per test — deliberately slow, and slow
 * for a reason that has nothing to do with what those tests assert. This writes
 * the same row the login path writes: a real token from the real generator, a
 * real SHA-256 hash in `sessions`, and a cookie the enforcement hook resolves
 * exactly as it resolves a browser's.
 *
 * It is a shortcut through the *credential*, not through authentication. The
 * hook still performs its full lookup, still rejects an expired, revoked, or
 * deactivated session, and still resolves capabilities from `role_capabilities`
 * — so a test that passes here is a test that would pass with a real login.
 * There is no bypass to build on: nothing in `src/` knows this file exists, and
 * no configuration flag turns enforcement off anywhere.
 *
 * `tests/integration/authLogin.test.ts` is where login itself is tested, and it
 * uses the real route.
 */

/**
 * When these sessions begin. Three hours before the clock the integration
 * suites pin, so a session created here is comfortably inside its twelve hours
 * at the moment a request arrives, and a test that advances a clock has room to
 * push one past its expiry deliberately.
 */
export const TEST_SESSION_START = new Date('2026-08-03T09:00:00.000Z');

export interface TestSessionOptions {
  role?: Role;
  username?: string;
  displayName?: string;
  password?: string;
  isActive?: boolean;
  /** Defaults to `TEST_SESSION_START`. */
  createdAt?: Date;
  /** Defaults to twelve hours after `createdAt`, as the login path would set it. */
  expiresAt?: Date;
  /** Set to revoke the session as it is created, for testing a dead cookie. */
  revokedAt?: Date;
}

export interface TestSession {
  user: TestUser;
  sessionId: string;
  /** What the browser would hold. Never stored. */
  rawToken: string;
  /** Ready to spread into `app.inject({ cookies })`. */
  cookies: Record<string, string>;
}

/**
 * Creates a user and one valid session for them.
 *
 * The username defaults to the role in lowercase (`owner`, `employee`,
 * `super.admin`), which is unique as long as a suite creates one session per
 * role. Pass `username` for a second person in the same role.
 */
export async function createTestSession(
  pool: DatabasePool,
  options: TestSessionOptions = {},
): Promise<TestSession> {
  const role: Role = options.role ?? 'OWNER';
  const createdAt = options.createdAt ?? TEST_SESSION_START;

  const user = await createTestUser(pool, {
    username: options.username ?? role.toLowerCase().replace(/_/g, '.'),
    password: options.password ?? 'correct horse battery staple',
    displayName: options.displayName ?? `Test ${role}`,
    role,
    ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
    now: createdAt,
  });

  return { ...(await createSessionFor(pool, user, options)), user };
}

/** A second (or third) session for somebody who already exists. */
export async function createSessionFor(
  pool: DatabasePool,
  user: TestUser,
  options: Pick<TestSessionOptions, 'createdAt' | 'expiresAt' | 'revokedAt'> = {},
): Promise<{ sessionId: string; rawToken: string; cookies: Record<string, string> }> {
  const createdAt = options.createdAt ?? TEST_SESSION_START;
  const expiresAt =
    options.expiresAt ?? new Date(createdAt.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);

  const sessionId = newId();
  const { rawToken, tokenHash } = generateSessionToken();

  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, user.id, tokenHash, createdAt, expiresAt, options.revokedAt ?? null],
  );

  return { sessionId, rawToken, cookies: sessionCookies(rawToken) };
}

/** The cookie a browser would send, in the shape `app.inject` wants. */
export function sessionCookies(rawToken: string): Record<string, string> {
  return { [SESSION_COOKIE_NAME]: rawToken };
}
