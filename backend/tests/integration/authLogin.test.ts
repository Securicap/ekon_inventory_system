import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticatedUserResponseSchema,
  DEFAULT_ROLE_CAPABILITIES,
  errorBodySchema,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createIdentityAuthService } from '../../src/modules/identity/index.js';
import {
  generateSessionToken,
  hashSessionToken,
  type GeneratedSessionToken,
} from '../../src/modules/identity/domain/sessionToken.js';
import { SESSION_COOKIE_NAME } from '../../src/modules/identity/sessionCookie.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { isUuid, newId } from '../../src/platform/ids/uuidv7.js';
import { createTestUser, sessions } from '../helpers/identityFixtures.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `POST /api/auth/login`, against a real database.
 *
 * The happy path is one test. The rest of this file is about what a failed
 * sign-in gives away, what ends up in the row, and what is in the cookie —
 * because those are the parts that are expensive to discover later.
 */

const NOW = new Date('2026-08-03T12:00:00.000Z');
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const PASSWORD = 'correct horse battery staple';

/** Whatever `inject` resolves to, without importing Fastify's test library. */
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

let db: TestDatabase;
let app: FastifyInstance;

async function post(payload: unknown): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function sessionCookie(response: InjectResponse): InjectResponse['cookies'][number] | undefined {
  return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
}

/** The raw `set-cookie` header, for attributes light-my-request does not model. */
function setCookieHeader(response: InjectResponse): string {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? header.join('\n') : String(header ?? '');
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = await buildApp({
    config: { ...loadConfig(), NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock: fixedClock(NOW),
  });
});

afterEach(async () => {
  await db.pool.query(`DELETE FROM sessions`);
  await db.pool.query(`DELETE FROM users`);
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('signing in', () => {
  it('returns the user and their current capabilities', async () => {
    const user = await createTestUser(db.pool, {
      username: 'marie.j',
      password: PASSWORD,
      displayName: 'Marie Joseph',
      role: 'OWNER',
    });

    const response = await post({ username: 'marie.j', password: PASSWORD });

    expect(response.statusCode).toBe(200);
    const body = authenticatedUserResponseSchema.parse(response.json());
    expect(body.user).toEqual({
      id: user.id,
      username: 'marie.j',
      displayName: 'Marie Joseph',
      role: 'OWNER',
      capabilities: [...DEFAULT_ROLE_CAPABILITIES.OWNER!].sort(),
    });
  });

  it('returns the capabilities of the role, not of every role', async () => {
    await createTestUser(db.pool, {
      username: 'jean',
      password: PASSWORD,
      role: 'EMPLOYEE',
    });

    const body = authenticatedUserResponseSchema.parse(
      (await post({ username: 'jean', password: PASSWORD })).json(),
    );
    expect(body.user.capabilities).toEqual(['catalog.read', 'inventory.read', 'inventory.receive']);
  });

  it('accepts the username however it was typed', async () => {
    await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    for (const typed of ['marie.j', '  marie.j  ', 'MARIE.J', ' Marie.J ']) {
      const response = await post({ username: typed, password: PASSWORD });
      expect(response.statusCode, `rejected ${JSON.stringify(typed)}`).toBe(200);
      expect(response.json().user.username).toBe('marie.j');
    }
  });

  it('writes one session that expires exactly twelve hours later', async () => {
    const user = await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    await post({ username: 'marie.j', password: PASSWORD });

    const rows = await sessions(db.pool);
    expect(rows).toHaveLength(1);
    const [session] = rows;
    expect(session?.user_id).toBe(user.id);
    expect(session?.created_at.toISOString()).toBe(NOW.toISOString());
    expect(session?.expires_at.getTime()).toBe(NOW.getTime() + TWELVE_HOURS_MS);
    expect(session?.revoked_at).toBeNull();
    // Absolute, from the injected clock — not the database's `now()`.
    expect(session?.expires_at.getTime() - session!.created_at.getTime()).toBe(TWELVE_HOURS_MS);
  });

  it('stores the hash of the cookie token, never the token', async () => {
    await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    const response = await post({ username: 'marie.j', password: PASSWORD });
    const token = sessionCookie(response)?.value ?? '';
    const [session] = await sessions(db.pool);

    expect(token).not.toBe('');
    expect(session?.token_hash).toBe(hashSessionToken(token));
    expect(session?.token_hash).not.toBe(token);
    expect(session?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // The whole table, searched for the token itself.
    const { rows } = await db.pool.query<{ found: string }>(
      `SELECT id AS found FROM sessions WHERE token_hash = $1 OR id::text = $1`,
      [token],
    );
    expect(rows).toHaveLength(0);
  });

  it('does not use the session id as the token', async () => {
    await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    const response = await post({ username: 'marie.j', password: PASSWORD });
    const token = sessionCookie(response)?.value;
    const [session] = await sessions(db.pool);

    expect(isUuid(session?.id ?? '')).toBe(true);
    expect(token).not.toBe(session?.id);
    expect(response.body).not.toContain(session?.id);
  });

  it('leaks nothing in the response body', async () => {
    await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    const response = await post({ username: 'marie.j', password: PASSWORD });
    const token = sessionCookie(response)?.value ?? '';
    const [session] = await sessions(db.pool);
    const { rows } = await db.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users`,
    );

    for (const secret of [
      PASSWORD,
      token,
      session?.token_hash ?? '',
      session?.id ?? '',
      rows[0]?.password_hash ?? '',
      'argon2',
    ]) {
      expect(response.body, `body contained ${secret.slice(0, 12)}`).not.toContain(secret);
    }
  });
});

describe('the session cookie', () => {
  beforeEach(async () => {
    await createTestUser(db.pool, { username: 'cookie.user', password: PASSWORD });
  });

  it('is http-only, lax, rooted, and expires with the session', async () => {
    const response = await post({ username: 'cookie.user', password: PASSWORD });
    const cookie = sessionCookie(response);
    const header = setCookieHeader(response);

    expect(cookie?.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.maxAge).toBe(43_200);

    // Attribute order is not part of any contract, so the header is checked by
    // attribute rather than compared as a string.
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//i);
    expect(header).toMatch(/Max-Age=43200/i);
    expect(header).not.toMatch(/Domain=/i);
  });

  it('is not Secure where injection speaks http', async () => {
    // A browser drops a Secure cookie on an insecure origin without saying so,
    // which would make every local sign-in fail silently.
    expect(
      setCookieHeader(await post({ username: 'cookie.user', password: PASSWORD })),
    ).not.toMatch(/Secure/i);
  });

  it('is Secure in production', async () => {
    const production = await buildApp({
      config: { ...loadConfig(), NODE_ENV: 'production', LOG_LEVEL: 'silent' },
      pool: db.pool,
      clock: fixedClock(NOW),
    });

    try {
      const response = await production.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username: 'cookie.user', password: PASSWORD }),
      });

      expect(response.statusCode).toBe(200);
      expect(setCookieHeader(response)).toMatch(/Secure/i);
      // Everything else is unchanged.
      expect(setCookieHeader(response)).toMatch(/HttpOnly/i);
      expect(setCookieHeader(response)).toMatch(/SameSite=Lax/i);
    } finally {
      await production.close();
    }
  });
});

describe('a sign-in that fails', () => {
  it('answers unknown username, wrong password, and deactivated account identically', async () => {
    await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });
    await createTestUser(db.pool, {
      username: 'gone',
      password: PASSWORD,
      isActive: false,
    });

    const responses = [
      await post({ username: 'nobody.here', password: PASSWORD }),
      await post({ username: 'marie.j', password: 'not the password' }),
      await post({ username: 'gone', password: PASSWORD }),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      const body = errorBodySchema.parse(response.json());
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.message).toBe('Invalid username or password');
      expect(body.error.details).toBeUndefined();
    }

    // Identical but for the request id, which every response carries.
    const shapes = responses.map((response) => {
      const { error } = errorBodySchema.parse(response.json());
      return JSON.stringify({ ...error, requestId: undefined });
    });
    expect(new Set(shapes).size).toBe(1);
  });

  it('sets no cookie and creates no session', async () => {
    await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    for (const payload of [
      { username: 'nobody.here', password: PASSWORD },
      { username: 'marie.j', password: 'not the password' },
    ]) {
      const response = await post(payload);
      expect(response.cookies).toHaveLength(0);
    }

    expect(await sessions(db.pool)).toHaveLength(0);
  });

  it('does not say whether the username exists', async () => {
    await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    const response = await post({ username: 'nobody.here', password: PASSWORD });
    const said = response.body.toLowerCase();
    for (const giveaway of [
      'nobody.here',
      'not found',
      'unknown user',
      'inactive',
      'deactivated',
    ]) {
      expect(said, `leaked "${giveaway}"`).not.toContain(giveaway);
    }
  });

  it('rejects a malformed request before it reaches a credential', async () => {
    await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    const rejected: [string, unknown][] = [
      ['no body at all', ''],
      ['broken json', '{"username": '],
      ['missing username', { password: PASSWORD }],
      ['missing password', { username: 'marie.j' }],
      ['an extra field', { username: 'marie.j', password: PASSWORD, role: 'OWNER' }],
      ['a session lifetime', { username: 'marie.j', password: PASSWORD, maxAge: 999_999 }],
      ['a short password', { username: 'marie.j', password: 'short' }],
      ['an overlong password', { username: 'marie.j', password: 'a'.repeat(129) }],
      ['an impossible username', { username: 'a b c', password: PASSWORD }],
      ['an overlong username', { username: 'a'.repeat(41), password: PASSWORD }],
      ['a username of the wrong type', { username: 42, password: PASSWORD }],
      ['a password of the wrong type', { username: 'marie.j', password: null }],
    ];

    for (const [what, payload] of rejected) {
      const response = await post(payload);
      expect(response.statusCode, what).toBe(400);
      expect(errorBodySchema.parse(response.json()).error.code, what).toBe('VALIDATION_FAILED');
      expect(response.cookies, what).toHaveLength(0);
    }

    expect(await sessions(db.pool)).toHaveLength(0);
  });
});

describe('signing in from more than one place', () => {
  it('creates independent sessions and revokes neither', async () => {
    // The owner works from another country while the shop laptop is signed in.
    // Neither sign-in may disturb the other.
    const user = await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    const shop = await post({ username: 'marie.j', password: PASSWORD });
    const abroad = await post({ username: 'marie.j', password: PASSWORD });

    const shopToken = sessionCookie(shop)?.value ?? '';
    const abroadToken = sessionCookie(abroad)?.value ?? '';
    expect(shopToken).not.toBe(abroadToken);

    const rows = await sessions(db.pool);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(new Set(rows.map((row) => row.token_hash)).size).toBe(2);
    expect(rows.every((row) => row.user_id === user.id)).toBe(true);
    expect(rows.every((row) => row.revoked_at === null)).toBe(true);

    for (const token of [shopToken, abroadToken]) {
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { [SESSION_COOKIE_NAME]: token },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.id).toBe(user.id);
    }
  });
});

describe('a token hash collision', () => {
  /**
   * Driven through the service rather than the route, because forcing the
   * collision means controlling the generator — and the point is to prove the
   * real UNIQUE constraint is what the retry answers, so the database is real.
   */
  it('retries with a fresh token and creates exactly one session', async () => {
    const user = await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

    // A session already holding the hash the first attempt will produce.
    const taken = generateSessionToken();
    await db.pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId(), user.id, taken.tokenHash, NOW, new Date(NOW.getTime() + TWELVE_HOURS_MS)],
    );

    const queued: GeneratedSessionToken[] = [taken, generateSessionToken()];
    let issued = 0;
    const service = createIdentityAuthService({
      pool: db.pool,
      clock: fixedClock(NOW),
      generateSessionToken: () => {
        const next = queued[issued];
        issued += 1;
        if (!next) throw new Error('generator asked for more tokens than the test queued');
        return next;
      },
    });

    const result = await service.login({ username: 'marie.j', password: PASSWORD });

    expect(issued).toBe(2);
    expect(result.rawSessionToken).toBe(queued[1]?.rawToken);

    const rows = await sessions(db.pool);
    expect(rows).toHaveLength(2); // the pre-existing one, and one new one
    expect(rows.filter((row) => row.token_hash === queued[1]?.tokenHash)).toHaveLength(1);

    // The collision did not disturb the session that already held the hash.
    const original = rows.find((row) => row.token_hash === taken.tokenHash);
    expect(original?.revoked_at).toBeNull();
  });
});

describe('what reaches the logs', () => {
  it('writes no password, hash, or session token', async () => {
    const lines: string[] = [];
    const noisy = await buildApp({
      // Everything the application would ever write, so nothing is missed by
      // being below the threshold.
      config: { ...loadConfig(), NODE_ENV: 'test', LOG_LEVEL: 'trace' },
      pool: db.pool,
      clock: fixedClock(NOW),
      logDestination: { write: (line) => lines.push(line) },
    });

    try {
      await createTestUser(db.pool, { username: 'marie.j', password: PASSWORD });

      const success = await noisy.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username: 'marie.j', password: PASSWORD }),
      });
      const token = sessionCookie(success)?.value ?? '';

      // A failed sign-in is a handled client error, not an unhandled fault: it
      // is logged at info, without a stack trace and without the credential.
      const failure = await noisy.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username: 'marie.j', password: `${PASSWORD} wrong` }),
      });
      expect(failure.statusCode).toBe(401);

      // Presenting the cookie, so the token has passed through a request too.
      await noisy.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { [SESSION_COOKIE_NAME]: token },
      });

      // And the redaction paths themselves, exercised on the running logger.
      noisy.log.info(
        {
          req: {
            body: { password: PASSWORD, currentPassword: PASSWORD, newPassword: PASSWORD },
            headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, authorization: 'Bearer nope' },
          },
        },
        'redaction check',
      );

      const captured = lines.join('\n');
      expect(captured).not.toBe('');
      expect(captured).not.toContain(PASSWORD);
      expect(captured).not.toContain(token);
      expect(captured).not.toContain(hashSessionToken(token));
      expect(captured).not.toContain('argon2');
      expect(captured).not.toContain('Bearer nope');
      // The 401 was logged, and logged as a handled error.
      expect(captured).toContain('handled application error');
      expect(captured).not.toContain('unhandled error');
    } finally {
      await noisy.close();
    }
  });
});
