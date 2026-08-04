import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticatedUserResponseSchema, errorBodySchema } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { hashSessionToken } from '../../src/modules/identity/domain/sessionToken.js';
import { SESSION_COOKIE_NAME } from '../../src/modules/identity/sessionCookie.js';
import type { Clock } from '../../src/platform/clock/index.js';
import { createTestUser, sessions, type TestUser } from '../helpers/identityFixtures.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `GET /api/auth/me` and `POST /api/auth/logout`, against a real database.
 *
 * These two are where the session model earns its cost. A session is a row, not
 * a token that carries its own answers, and that only matters if a revocation,
 * a deactivation, a demotion, or a change to what a role may do lands on the
 * *next* request. Each of those is a test here, and none of them replaces the
 * session or asks anybody to sign in again.
 */

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const NOW = new Date('2026-08-03T12:00:00.000Z');
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const PASSWORD = 'correct horse battery staple';

let db: TestDatabase;
let app: FastifyInstance;
let user: TestUser;

/**
 * A clock the tests move. Expiry is a question about the moment a request
 * arrives, so advancing this is how a session gets old — no sleeping, and no
 * dependence on the database's clock.
 */
let currentTime = NOW.getTime();
const clock: Clock = { now: () => new Date(currentTime) };
const advance = (ms: number): void => {
  currentTime += ms;
};

async function login(username = user.username, password = PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password }),
  });
  expect(response.statusCode).toBe(200);
  const token = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value;
  expect(token).toBeTruthy();
  return token ?? '';
}

function me(token?: string | null): Promise<InjectResponse> {
  return app.inject({
    method: 'GET',
    url: '/api/auth/me',
    ...(token == null ? {} : { cookies: { [SESSION_COOKIE_NAME]: token } }),
  });
}

function logout(token?: string | null): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    ...(token == null ? {} : { cookies: { [SESSION_COOKIE_NAME]: token } }),
  });
}

function expectUnauthenticated(response: InjectResponse): void {
  expect(response.statusCode).toBe(401);
  const body = errorBodySchema.parse(response.json());
  expect(body.error.code).toBe('UNAUTHENTICATED');
  expect(body.error.message).toBe('Authentication required');
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = await buildApp({
    config: { ...loadConfig(), NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock,
  });
});

beforeEach(async () => {
  currentTime = NOW.getTime();
  await db.pool.query(`DELETE FROM sessions`);
  await db.pool.query(`DELETE FROM users`);

  user = await createTestUser(db.pool, {
    username: 'marie.j',
    password: PASSWORD,
    displayName: 'Marie Joseph',
    role: 'OWNER',
  });
});

afterEach(async () => {
  // Undo any grant a test added or removed, so the seed is what the next test
  // sees.
  await db.pool.query(`DELETE FROM role_capabilities WHERE capability = 'reports.export'`);
  await db.pool.query(
    `INSERT INTO role_capabilities (role, capability)
     VALUES ('SUPER_ADMIN', 'reports.export'), ('OWNER', 'reports.export'), ('MANAGER', 'reports.export')
     ON CONFLICT DO NOTHING`,
  );
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid session', async () => {
    const token = await login();

    const response = await me(token);
    expect(response.statusCode).toBe(200);
    const body = authenticatedUserResponseSchema.parse(response.json());
    expect(body.user).toEqual({
      id: user.id,
      username: 'marie.j',
      displayName: 'Marie Joseph',
      role: 'OWNER',
      capabilities: body.user.capabilities,
    });
    expect(body.user.capabilities).toContain('identity.manage');
  });

  it('refuses a request with no cookie', async () => {
    expectUnauthenticated(await me(null));
  });

  it('refuses a token that was never issued', async () => {
    await login();
    expectUnauthenticated(await me('7Xk3nOtArEaLtOkEnAtAlL_0123456789abcdefghij'));
  });

  it('refuses arbitrary rubbish in the cookie without failing', async () => {
    // A cookie is attacker-controlled. None of this may become a 500.
    for (const value of ['', ' ', '{}', "'; DROP TABLE sessions;--", 'a'.repeat(5_000), '😀']) {
      const response = await me(value);
      expect(response.statusCode, JSON.stringify(value.slice(0, 20))).toBe(401);
    }
  });

  it('refuses a session past its twelve hours', async () => {
    const token = await login();
    expect((await me(token)).statusCode).toBe(200);

    // One millisecond before expiry, and then exactly at it. Expiry is
    // evaluated against the injected clock, not the database's.
    advance(TWELVE_HOURS_MS - 1);
    expect((await me(token)).statusCode).toBe(200);

    advance(1);
    expectUnauthenticated(await me(token));

    // The row is still there. It is refused, not forgotten.
    expect(await sessions(db.pool)).toHaveLength(1);
  });

  it('refuses a revoked session', async () => {
    const token = await login();
    await logout(token);
    expectUnauthenticated(await me(token));
  });

  it('refuses a deactivated user, on the next request', async () => {
    const token = await login();
    expect((await me(token)).statusCode).toBe(200);

    await db.pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [user.id]);

    expectUnauthenticated(await me(token));
    // Nothing was revoked or deleted to make that true — activity is re-read
    // every time a token is resolved.
    const [session] = await sessions(db.pool);
    expect(session?.revoked_at).toBeNull();
  });

  it('reflects a role change without replacing the session', async () => {
    const token = await login();
    expect((await me(token)).json().user.role).toBe('OWNER');

    await db.pool.query(`UPDATE users SET role = 'EMPLOYEE' WHERE id = $1`, [user.id]);

    const demoted = authenticatedUserResponseSchema.parse((await me(token)).json());
    expect(demoted.user.role).toBe('EMPLOYEE');
    expect(demoted.user.capabilities).toEqual([
      'catalog.read',
      'inventory.read',
      'inventory.receive',
    ]);
    // Same session, same cookie. The demotion did not sign anybody out.
    expect(await sessions(db.pool)).toHaveLength(1);
  });

  it('reflects a change to what a role may do', async () => {
    const token = await login();
    expect((await me(token)).json().user.capabilities).toContain('reports.export');

    // What `role_capabilities` says now is what the answer is — the session row
    // holds no snapshot of it.
    await db.pool.query(`DELETE FROM role_capabilities WHERE role = 'OWNER' AND capability = $1`, [
      'reports.export',
    ]);
    expect((await me(token)).json().user.capabilities).not.toContain('reports.export');

    await db.pool.query(`INSERT INTO role_capabilities (role, capability) VALUES ('OWNER', $1)`, [
      'reports.export',
    ]);
    expect((await me(token)).json().user.capabilities).toContain('reports.export');
  });

  it('returns capabilities in the same order every time', async () => {
    const token = await login();
    const first = (await me(token)).json().user.capabilities;
    const second = (await me(token)).json().user.capabilities;
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });

  it('is read-only: it neither extends the session nor touches the cookie', async () => {
    const token = await login();
    const before = (await sessions(db.pool))[0];

    advance(60_000);
    const response = await me(token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();

    const after = (await sessions(db.pool))[0];
    expect(after).toEqual(before);
  });

  it('does not clear the cookie when it refuses', async () => {
    // Keeping `/me` read-only means the browser's state does not depend on
    // which endpoint happened to be called first.
    const response = await me('not-a-token');
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('returns nothing secret', async () => {
    const token = await login();
    const response = await me(token);
    const { rows } = await db.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users`,
    );
    const [session] = await sessions(db.pool);

    for (const secret of [
      PASSWORD,
      token,
      hashSessionToken(token),
      session?.id ?? '',
      rows[0]?.password_hash ?? '',
      'argon2',
    ]) {
      expect(response.body, `body contained ${secret.slice(0, 12)}`).not.toContain(secret);
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the presented session and clears the cookie', async () => {
    const token = await login();
    advance(60_000);

    const response = await logout(token);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');

    const [session] = await sessions(db.pool);
    expect(session?.revoked_at?.toISOString()).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    // Revoked, not deleted: the row is the record that a session existed and
    // when it ended.
    expect(await sessions(db.pool)).toHaveLength(1);
    expect(session?.expires_at.getTime()).toBe(NOW.getTime() + TWELVE_HOURS_MS);

    const cleared = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
    expect(cleared?.value).toBe('');
    expect(cleared?.path).toBe('/');
    expect(cleared?.httpOnly).toBe(true);
    expect(cleared?.sameSite?.toLowerCase()).toBe('lax');
    // An expiry in the past is what makes the browser drop it.
    expect(cleared?.expires?.getTime() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      NOW.getTime(),
    );
  });

  it('ends the session for the next request', async () => {
    const token = await login();
    expect((await me(token)).statusCode).toBe(200);

    await logout(token);

    expectUnauthenticated(await me(token));
  });

  it('answers 204 whatever the cookie turns out to be', async () => {
    // A logout that answered differently would be a way to ask whether a token
    // is real.
    const expired = await login();
    advance(TWELVE_HOURS_MS + 1);

    const cases: [string, string | null][] = [
      ['no cookie at all', null],
      ['an empty cookie', ''],
      ['a token nobody issued', 'Ur4nD0mStR1nGtHaTiSnOtAtOkEn_012345678901234'],
      ['rubbish', "'; DROP TABLE sessions;--"],
      ['an expired session', expired],
    ];

    for (const [what, token] of cases) {
      const response = await logout(token);
      expect(response.statusCode, what).toBe(204);
      expect(response.body, what).toBe('');
      // The browser is left holding nothing either way.
      expect(
        response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value,
        what,
      ).toBe('');
    }
  });

  it('is idempotent, and keeps the moment the session actually ended', async () => {
    const token = await login();
    advance(60_000);
    await logout(token);
    const first = (await sessions(db.pool))[0]?.revoked_at;

    advance(60_000);
    expect((await logout(token)).statusCode).toBe(204);
    expect((await logout(token)).statusCode).toBe(204);

    expect((await sessions(db.pool))[0]?.revoked_at).toEqual(first);
  });

  it('ends one session, not every session the person has', async () => {
    // Signing out of the shop laptop must not sign the owner out of the browser
    // they are working in elsewhere.
    const shop = await login();
    const abroad = await login();

    await logout(shop);

    expectUnauthenticated(await me(shop));
    expect((await me(abroad)).statusCode).toBe(200);

    const rows = await sessions(db.pool);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at !== null)).toHaveLength(1);
    expect(rows.find((row) => row.token_hash === hashSessionToken(abroad))?.revoked_at).toBeNull();
  });

  it('cannot revoke another session by presenting a token that matches no row', async () => {
    const token = await login();
    await logout('a-token-that-matches-no-row');

    expect((await me(token)).statusCode).toBe(200);
    expect((await sessions(db.pool))[0]?.revoked_at).toBeNull();
  });
});
