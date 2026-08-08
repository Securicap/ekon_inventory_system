import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authenticatedUserResponseSchema,
  createUserResponseSchema,
  DEFAULT_ROLE_CAPABILITIES,
  ROLES,
  type ErrorBody,
  type Role,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { SESSION_COOKIE_NAME } from '../../src/modules/identity/sessionCookie.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { isUuid } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { sessions } from '../helpers/identityFixtures.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `POST /api/identity/users`, end to end, against real PostgreSQL.
 *
 * This is the workflow the bootstrap command has always pointed at: the first
 * owner is created by an operator, and everybody after them is created from
 * inside the application by somebody holding `identity.manage`. Until it
 * existed a shop could sign its owner in and nothing else — there was no
 * supported way to give an employee an account.
 *
 * So the test that matters most here is not the `201`. It is that the account
 * this route creates can then be **signed in to through the real login route**,
 * and that what it may do afterwards is exactly what `role_capabilities` grants
 * its role — never anything the request asked for. The rest of the file is
 * about what the request may not say, and about what is not created: no
 * session, no capability list, no plaintext anywhere.
 *
 * Generic enforcement — that an undeclared route cannot start, that a `403`
 * reveals nothing, that a permission change lands on the next request — is
 * proved once in `authorization.test.ts` and is not repeated. What is asserted
 * here is only what is true of *this* route.
 */

/** Server time, from the injected clock. Inside the test sessions' lifetime. */
const NOW = new Date('2026-08-03T12:00:00.000Z');

/** Long enough for the shared bounds, and not a password anybody would reuse. */
const NEW_PASSWORD = 'zoranj kokoye diri';

let db: TestDatabase;
let app: FastifyInstance;
/** An owner: holds `identity.manage`, so this route is theirs. */
let owner: TestSession;
/** A manager: every capability except `identity.manage`. The 403 case. */
let manager: TestSession;

interface Injected {
  status: number;
  body: unknown;
  cookies: Awaited<ReturnType<FastifyInstance['inject']>>['cookies'];
}

let usernameCounter = 0;
/** A fresh username per account, so no test depends on another's leftovers. */
function nextUsername(): string {
  usernameCounter += 1;
  return `person.${usernameCounter}`;
}

/** A well-formed creation body, with anything a test cares about overridden. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    username: nextUsername(),
    displayName: 'Nouvo Anplwaye',
    password: NEW_PASSWORD,
    role: 'EMPLOYEE',
    ...overrides,
  };
}

async function createUser(
  payload: unknown,
  session: TestSession | null = owner,
): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/identity/users',
    headers: { 'content-type': 'application/json' },
    ...(session ? { cookies: session.cookies } : {}),
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { status: response.statusCode, body: response.json(), cookies: response.cookies };
}

/** Posts a body that is expected to succeed, and returns the parsed result. */
async function createUserOk(payload: unknown, session: TestSession = owner) {
  const { status, body: responseBody } = await createUser(payload, session);
  expect(status, JSON.stringify(responseBody)).toBe(201);
  return createUserResponseSchema.parse(responseBody).user;
}

/** Signs in through the real login route, exactly as a browser would. */
async function login(username: string, password: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password }),
  });
  return {
    status: response.statusCode,
    body: response.json(),
    token: response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value,
  };
}

function errorCode(responseBody: unknown): string {
  return (responseBody as ErrorBody).error.code;
}

function errorPaths(responseBody: unknown): string[] {
  return ((responseBody as ErrorBody).error.details ?? []).map((detail) => detail.path);
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

async function userRow(username: string): Promise<UserRow | undefined> {
  const { rows } = await db.pool.query<UserRow>(`SELECT * FROM users WHERE username = $1`, [
    username,
  ]);
  return rows[0];
}

async function userCount(): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(`SELECT count(*) FROM users`);
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool);
  manager = await createTestSession(db.pool, { role: 'MANAGER' });
  app = await buildApp({
    config: { ...loadConfig(), LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock: fixedClock(NOW),
  });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('creating an account', () => {
  it('writes one active user and returns it without its hash', async () => {
    const request = body({ username: 'marie.pierre', displayName: 'Marie Pierre' });

    const created = await createUserOk(request);

    // The response is the shared contract and nothing more — in particular, no
    // password hash and no capability list.
    expect(Object.keys(created).sort()).toEqual([
      'createdAt',
      'displayName',
      'id',
      'isActive',
      'role',
      'username',
    ]);
    expect(isUuid(created.id)).toBe(true);
    expect(created.username).toBe('marie.pierre');
    expect(created.displayName).toBe('Marie Pierre');
    expect(created.role).toBe('EMPLOYEE');
    // Server-owned, both of them. The request could not have said either.
    expect(created.isActive).toBe(true);
    expect(created.createdAt).toBe(NOW.toISOString());

    const row = await userRow('marie.pierre');
    expect(row?.id).toBe(created.id);
    expect(row?.display_name).toBe('Marie Pierre');
    expect(row?.role).toBe('EMPLOYEE');
    expect(row?.is_active).toBe(true);
    expect(row?.created_at.toISOString()).toBe(NOW.toISOString());
    expect(row?.updated_at.toISOString()).toBe(NOW.toISOString());

    // What is in the password column is an Argon2id hash of the plaintext, and
    // never the plaintext. `hashPassword` is what produced it.
    expect(row?.password_hash).toMatch(/^\$argon2id\$/);
    expect(row?.password_hash).not.toContain(NEW_PASSWORD);
  });

  it('normalizes the username exactly as the login route does', async () => {
    // `" Yves.M "` and `yves.m` are one account. The shared schema normalizes
    // on both sides, so an account is created under the name it signs in with.
    const created = await createUserOk(body({ username: '  Yves.M  ' }));

    expect(created.username).toBe('yves.m');
    expect(await userRow('yves.m')).toBeDefined();

    const signedIn = await login('YVES.M', NEW_PASSWORD);
    expect(signedIn.status).toBe(200);
  });

  it('trims the display name and keeps its case', async () => {
    const created = await createUserOk(body({ displayName: '  Jean Baptiste  ' }));
    expect(created.displayName).toBe('Jean Baptiste');
  });

  it('creates every role in the closed set', async () => {
    // No role a holder of `identity.manage` can create exceeds their own
    // authority — that invariant is asserted in `tests/unit/capabilities.test.ts`
    // — so the route accepts the vocabulary rather than a second, narrower list
    // that would have to be kept in step with it.
    for (const role of ROLES) {
      const created = await createUserOk(body({ role }));
      expect(created.role).toBe(role);
      expect((await userRow(created.username))?.role).toBe(role);
    }
  });
});

describe('the account that was created', () => {
  it('can sign in through the real login route and holds its role grants', async () => {
    // The point of the whole PR: an employee who did not exist this morning can
    // sign in this afternoon and do the counter job.
    const created = await createUserOk(body({ displayName: 'Nadege Louis' }));

    const signedIn = await login(created.username, NEW_PASSWORD);
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    expect(signedIn.token).toBeTruthy();

    const { user } = authenticatedUserResponseSchema.parse(signedIn.body);
    expect(user.id).toBe(created.id);
    expect(user.username).toBe(created.username);
    expect(user.displayName).toBe('Nadege Louis');
    expect(user.role).toBe('EMPLOYEE');

    /**
     * The capabilities came from `role_capabilities`, through the same
     * resolution every request performs — not from the creation request, which
     * has no field that could have named one.
     */
    expect(user.capabilities).toEqual([...(DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? [])].sort());
    expect(user.capabilities).not.toContain('identity.manage');
    expect(user.capabilities).not.toContain('inventory.adjust');
  });

  it('reaches exactly the inventory routes its capabilities open', async () => {
    const created = await createUserOk(body());
    const signedIn = await login(created.username, NEW_PASSWORD);
    const cookies = { [SESSION_COOKIE_NAME]: signedIn.token ?? '' };

    // `inventory.read` and `catalog.read`: granted, and the route answers.
    for (const url of [
      '/api/inventory/balances',
      '/api/inventory/locations',
      '/api/catalog/products',
    ]) {
      const read = await app.inject({ method: 'GET', url, cookies });
      expect(read.statusCode, url).toBe(200);
    }

    /**
     * `inventory.receive` and `inventory.remove`: granted, so the enforcement
     * hook lets them through to the handler. An empty body is then a `400` from
     * the route's own schema — which is the proof, because a `403` is what the
     * hook returns and a `400` is what only a caller who got past it can see.
     */
    for (const url of ['/api/inventory/receive', '/api/inventory/remove']) {
      const write = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        cookies,
        payload: '{}',
      });
      expect(write.statusCode, url).toBe(400);
      expect(errorCode(write.json()), url).toBe('VALIDATION_FAILED');
    }

    // `catalog.write` was never granted, and the new account cannot borrow it.
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/catalog/products',
      headers: { 'content-type': 'application/json' },
      cookies,
      payload: JSON.stringify({ name: 'Diri', variants: [{ attributes: {} }] }),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(errorCode(forbidden.json())).toBe('FORBIDDEN');

    // Nor can it create further accounts: `identity.manage` is not an employee's.
    const cannotCreate = await app.inject({
      method: 'POST',
      url: '/api/identity/users',
      headers: { 'content-type': 'application/json' },
      cookies,
      payload: JSON.stringify(body()),
    });
    expect(cannotCreate.statusCode).toBe(403);
    expect(errorCode(cannotCreate.json())).toBe('FORBIDDEN');
  });

  it('is created without a session, and leaves the caller signed in as themselves', async () => {
    const before = await sessions(db.pool);

    const response = await createUser(body());
    expect(response.status).toBe(201);

    // Creating somebody's account is not signing in as them. No cookie is set
    // — not for the new user, and not a refreshed one for the caller.
    expect(response.cookies).toHaveLength(0);

    // And no session row was written for anybody.
    const after = await sessions(db.pool);
    expect(after).toHaveLength(before.length);

    // The caller is still themselves on the next request.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: owner.cookies });
    expect(me.statusCode).toBe(200);
    expect(authenticatedUserResponseSchema.parse(me.json()).user.id).toBe(owner.user.id);
  });
});

describe('who may create an account', () => {
  it('refuses an anonymous request with 401 and writes nothing', async () => {
    const before = await userCount();
    const request = body();

    const { status, body: responseBody } = await createUser(request, null);

    expect(status).toBe(401);
    expect(errorCode(responseBody)).toBe('UNAUTHENTICATED');
    expect(await userCount()).toBe(before);
    expect(await userRow(request.username as string)).toBeUndefined();
  });

  it('refuses a signed-in caller without identity.manage with 403', async () => {
    // A manager holds every other capability in the system. This is the one
    // they do not, and the route is not open to them because of it.
    const before = await userCount();
    const request = body();

    const { status, body: responseBody } = await createUser(request, manager);

    expect(status).toBe(403);
    expect(errorCode(responseBody)).toBe('FORBIDDEN');
    expect(await userCount()).toBe(before);
    expect(await userRow(request.username as string)).toBeUndefined();
  });

  it('refuses an anonymous malformed request before it validates it', async () => {
    // Enforcement is an `onRequest` hook, so an unusable request from nobody is
    // still `401` — answering `400` would tell an anonymous caller which fields
    // this endpoint expects, and which usernames it would have rejected.
    const garbage = await createUser({ nonsense: true }, null);
    expect(garbage.status).toBe(401);
    expect(errorCode(garbage.body)).toBe('UNAUTHENTICATED');

    const brokenJson = await createUser('{ not json', null);
    expect(brokenJson.status).toBe(401);
    expect(errorCode(brokenJson.body)).toBe('UNAUTHENTICATED');
  });
});

describe('a username that is already taken', () => {
  it('is a 409 in the standard envelope, and the first account is untouched', async () => {
    const first = await createUserOk(body({ username: 'claudette', displayName: 'Claudette A' }));

    const duplicate = await createUser(
      body({ username: 'claudette', displayName: 'Somebody Else' }),
    );

    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe('CONFLICT');
    // The structured envelope, with the correlation id every failure carries.
    expect((duplicate.body as ErrorBody).error.requestId).toBeTruthy();

    // One row, still the first person's, with their display name and their
    // credential. A refused duplicate must not overwrite anything.
    const { rows } = await db.pool.query(`SELECT * FROM users WHERE username = 'claudette'`);
    expect(rows).toHaveLength(1);
    const row = await userRow('claudette');
    expect(row?.id).toBe(first.id);
    expect(row?.display_name).toBe('Claudette A');

    // And the original can still sign in — the second attempt did not rewrite
    // the hash on the way to being refused.
    expect((await login('claudette', NEW_PASSWORD)).status).toBe(200);
  });

  it('catches a duplicate that differs only in case or padding', async () => {
    await createUserOk(body({ username: 'georges.p' }));

    const duplicate = await createUser(body({ username: '  Georges.P  ' }));
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe('CONFLICT');
  });
});

describe('what a request may say', () => {
  /** Asserts a body is refused as a 400 and that it created nobody. */
  async function rejects(payload: Record<string, unknown>, expectedPath?: string): Promise<void> {
    const before = await userCount();
    const { status, body: responseBody } = await createUser(payload);

    expect(status, JSON.stringify(responseBody)).toBe(400);
    expect(errorCode(responseBody)).toBe('VALIDATION_FAILED');
    if (expectedPath) expect(errorPaths(responseBody)).toContain(expectedPath);
    expect(await userCount()).toBe(before);
  }

  // Upper case and padding are deliberately absent from this list: the shared
  // schema normalizes before it validates, so `" Marie.J "` is a valid way to
  // write `marie.j` rather than a rejection. The test above proves it, and the
  // duplicate suite proves two spellings cannot become two accounts.
  it.each([
    ['too short', 'ab'],
    ['too long', `a${'b'.repeat(40)}`],
    ['spaced', 'marie pierre'],
    ['punctuated', 'marie@pierre'],
    ['accented', 'andrée'],
    ['blank', '   '],
    ['empty', ''],
  ])('refuses a %s username', async (_label, username) => {
    await rejects(body({ username }), 'username');
  });

  it.each([
    ['blank', '   '],
    ['empty', ''],
    ['too long', 'x'.repeat(121)],
  ])('refuses a %s display name', async (_label, displayName) => {
    await rejects(body({ displayName }), 'displayName');
  });

  it.each([
    ['too short', 'nine char'],
    ['empty', ''],
    ['too long', 'x'.repeat(129)],
  ])('refuses a %s password', async (_label, password) => {
    await rejects(body({ password }), 'password');
  });

  it.each([
    ['unknown', 'ADMIN'],
    ['lower case', 'employee'],
    ['empty', ''],
  ])('refuses a %s role', async (_label, role) => {
    await rejects(body({ role }), 'role');
  });

  it.each(['username', 'displayName', 'password', 'role'])(
    'refuses a request missing %s',
    async (field) => {
      const payload = body();
      delete payload[field];
      await rejects(payload, field);
    },
  );

  it.each([
    'id',
    'passwordHash',
    'password_hash',
    'isActive',
    'is_active',
    'capabilities',
    'createdAt',
    'updatedAt',
  ])('refuses a request that tries to supply %s', async (field) => {
    // Every one of these is the server's. Rejecting rather than ignoring is
    // what stops a client discovering that sending one is harmless — and
    // `capabilities` is the one that would be a privilege escalation if it
    // were merely dropped somewhere quietly.
    await rejects(body({ [field]: 'anything' }));
  });

  it('refuses a capability list even when it names real capabilities', async () => {
    await rejects(body({ role: 'EMPLOYEE', capabilities: ['identity.manage'] }));
  });

  it('refuses malformed JSON', async () => {
    const before = await userCount();
    const { status, body: responseBody } = await createUser('{ "username": ');

    expect(status).toBe(400);
    expect(errorCode(responseBody)).toBe('VALIDATION_FAILED');
    expect(await userCount()).toBe(before);
  });
});

describe('what reaches the logs', () => {
  it('writes no plaintext password, on success or on refusal', async () => {
    /**
     * The field is called `password`, which is already on the application's
     * redaction list — `req.body.password`, the same path the login route
     * relies on. This asserts that rather than assuming it, against a real
     * logger at `trace`, because the cost of being wrong is a credential on
     * disk in whatever aggregates logs.
     *
     * Both outcomes are exercised: a `201`, and a `409` whose message is built
     * from the request. A handled error logs the `AppError` it threw, so a
     * message that had interpolated the password would appear here.
     */
    const lines: string[] = [];
    const secret = 'kokoye mango zaboka';
    const noisy = await buildApp({
      config: { ...loadConfig(), NODE_ENV: 'test', LOG_LEVEL: 'trace' },
      pool: db.pool,
      clock: fixedClock(NOW),
      logDestination: { write: (line) => lines.push(line) },
    });

    try {
      const username = nextUsername();
      const created = await noisy.inject({
        method: 'POST',
        url: '/api/identity/users',
        headers: { 'content-type': 'application/json' },
        cookies: owner.cookies,
        payload: JSON.stringify({
          username,
          displayName: 'Log Check',
          password: secret,
          role: 'EMPLOYEE',
        }),
      });
      expect(created.statusCode).toBe(201);
      // Not in the response body either — the contract has no such field, and
      // this is the assertion that would notice if one were ever added.
      expect(created.body).not.toContain(secret);

      const duplicate = await noisy.inject({
        method: 'POST',
        url: '/api/identity/users',
        headers: { 'content-type': 'application/json' },
        cookies: owner.cookies,
        payload: JSON.stringify({
          username,
          displayName: 'Log Check',
          password: secret,
          role: 'EMPLOYEE',
        }),
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.body).not.toContain(secret);

      const captured = lines.join('\n');
      expect(captured).not.toBe('');
      expect(captured).not.toContain(secret);
      // Nor the stored credential it became.
      expect(captured).not.toContain('argon2');
      // The 409 was logged, and logged as something handled rather than a fault.
      expect(captured).toContain('handled application error');
      expect(captured).not.toContain('unhandled error');
    } finally {
      await noisy.close();
    }
  });
});
