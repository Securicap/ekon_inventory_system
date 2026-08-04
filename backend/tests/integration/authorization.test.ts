import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticatedUserResponseSchema, errorBodySchema, REQUEST_ID_HEADER } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { requireActor } from '../../src/modules/identity/index.js';
import type { Clock } from '../../src/platform/clock/index.js';
import type { DatabasePool } from '../../src/platform/db/pool.js';
import { createTestSession, sessionCookies, type TestSession } from '../helpers/authSession.js';
import { sessions } from '../helpers/identityFixtures.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Who may call what, against real routes, real sessions, and the real seeded
 * role-capability mapping.
 *
 * The distinction this file is built around is the one that matters at the
 * counter: **401 means nobody is signed in, 403 means you are and you may not.**
 * The first is fixed by signing in and the second is not, so answering the
 * wrong one sends somebody to the wrong remedy — and answering 404 to hide an
 * authorization failure, which this system deliberately does not do, sends them
 * to look for a page that exists.
 *
 * Nothing here tests a role name against a handler. Roles decide capabilities,
 * capabilities decide access, and the tests go through the same door: a
 * manager is denied nothing here because they are a manager, but because of
 * what `role_capabilities` currently grants them.
 */

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const NOW = new Date('2026-08-03T12:00:00.000Z');
const clock: Clock = { now: () => NOW };

const CATALOG = '/api/catalog/products';
const LOCATIONS = '/api/inventory/locations';
/** Registered on the test instance only; see the actor-trust suite below. */
const WHOAMI = '/api/_test/whoami';
const GUARDED = '/api/_test/guarded';

let db: TestDatabase;
let app: FastifyInstance;
let owner: TestSession;
let manager: TestSession;
let employee: TestSession;

/** Every statement the application makes, so a test can count session lookups. */
let statements: string[] = [];

/**
 * The real pool, with every query recorded. A proxy rather than a stub: the
 * queries still run against real Postgres, and only the observation is added.
 */
function recordingPool(pool: DatabasePool): DatabasePool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (...args: unknown[]) => {
          statements.push(String(args[0]));
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** How many times a session was resolved to a principal. */
function sessionLookups(): number {
  return statements.filter((sql) => sql.includes('FROM sessions s')).length;
}

function get(url: string, session?: TestSession): Promise<InjectResponse> {
  return app.inject({ method: 'GET', url, ...(session ? { cookies: session.cookies } : {}) });
}

function post(url: string, session?: TestSession, payload: unknown = {}): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    ...(session ? { cookies: session.cookies } : {}),
    payload: JSON.stringify(payload),
  });
}

/** A distinct name per call: several tests create one and count the rows. */
let productSequence = 0;
function aProduct(): { name: string; variants: { attributes: Record<string, string> }[] } {
  productSequence += 1;
  return { name: `Bottled Water ${productSequence}`, variants: [{ attributes: {} }] };
}

async function productCount(): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM products`,
  );
  return Number(rows[0]?.count ?? '0');
}

async function operationCount(): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM operations`,
  );
  return Number(rows[0]?.count ?? '0');
}

function expectUnauthenticated(response: InjectResponse): void {
  expect(response.statusCode).toBe(401);
  const body = errorBodySchema.parse(response.json());
  expect(body.error.code).toBe('UNAUTHENTICATED');
  expect(body.error.message).toBe('Authentication required');
  expect(body.error.requestId).toBeTruthy();
}

function expectForbidden(response: InjectResponse): void {
  expect(response.statusCode).toBe(403);
  const body = errorBodySchema.parse(response.json());
  expect(body.error.code).toBe('FORBIDDEN');
  expect(body.error.message).toBe('You do not have permission to perform this action');
  expect(body.error.requestId).toBeTruthy();
}

/** Counts handler entries, to prove a denied request never reaches one. */
let guardedHandlerCalls = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await buildApp({
    config: { ...loadConfig(), NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    pool: recordingPool(db.pool),
    clock,
  });

  /**
   * Two test-only routes, registered on the test instance and never in
   * production code. They exist because the questions they answer — what a
   * handler sees as its actor, and whether a handler runs at all when the
   * request is denied — cannot be asked of a route that also does business
   * work.
   */
  app.post(WHOAMI, { config: { auth: 'authenticated' } }, async (request) => ({
    actor: requireActor(request),
  }));

  app.post(GUARDED, { config: { capability: 'inventory.adjust' } }, async () => {
    guardedHandlerCalls += 1;
    return { reached: true };
  });

  owner = await createTestSession(db.pool, { role: 'OWNER' });
  manager = await createTestSession(db.pool, { role: 'MANAGER' });
  employee = await createTestSession(db.pool, { role: 'EMPLOYEE' });
});

beforeEach(() => {
  statements = [];
  guardedHandlerCalls = 0;
});

afterEach(async () => {
  // Back to the seed after every test: several of these change what a role may
  // do, or who somebody is, precisely to watch the change take effect.
  await db.pool.query(`DELETE FROM role_capabilities`);
  await db.pool.query(`
    INSERT INTO role_capabilities (role, capability) VALUES
      ('SUPER_ADMIN','catalog.read'),('SUPER_ADMIN','catalog.write'),('SUPER_ADMIN','catalog.deactivate'),
      ('SUPER_ADMIN','inventory.read'),('SUPER_ADMIN','inventory.receive'),('SUPER_ADMIN','inventory.adjust'),
      ('SUPER_ADMIN','inventory.count'),('SUPER_ADMIN','inventory.reverse'),('SUPER_ADMIN','audit.read'),
      ('SUPER_ADMIN','identity.manage'),('SUPER_ADMIN','reports.export'),
      ('OWNER','catalog.read'),('OWNER','catalog.write'),('OWNER','catalog.deactivate'),
      ('OWNER','inventory.read'),('OWNER','inventory.receive'),('OWNER','inventory.adjust'),
      ('OWNER','inventory.count'),('OWNER','inventory.reverse'),('OWNER','audit.read'),
      ('OWNER','identity.manage'),('OWNER','reports.export'),
      ('MANAGER','catalog.read'),('MANAGER','catalog.write'),('MANAGER','catalog.deactivate'),
      ('MANAGER','inventory.read'),('MANAGER','inventory.receive'),('MANAGER','inventory.adjust'),
      ('MANAGER','inventory.count'),('MANAGER','inventory.reverse'),('MANAGER','audit.read'),
      ('MANAGER','reports.export'),
      ('EMPLOYEE','catalog.read'),('EMPLOYEE','inventory.read'),('EMPLOYEE','inventory.receive')
  `);
  await db.pool.query(`UPDATE users SET is_active = true`);
  await db.pool.query(`UPDATE users SET role = 'OWNER' WHERE id = $1`, [owner.user.id]);
  await db.pool.query(`UPDATE users SET role = 'MANAGER' WHERE id = $1`, [manager.user.id]);
  await db.pool.query(`UPDATE users SET role = 'EMPLOYEE' WHERE id = $1`, [employee.user.id]);
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('public routes', () => {
  it('answer without a session', async () => {
    expect((await get('/api/health')).statusCode).toBe(200);

    // Login reaches its own validation, which is proof it was not intercepted:
    // an enforced route would have answered 401 before reading the body.
    const login = await post('/api/auth/login', undefined, { username: 'nobody' });
    expect(login.statusCode).toBe(400);
    expect(errorBodySchema.parse(login.json()).error.code).toBe('VALIDATION_FAILED');

    expect((await post('/api/auth/logout')).statusCode).toBe(204);
  });

  it('do not look up a session', async () => {
    // A health check that queried `sessions` would make the readiness of the
    // instance depend on a table it does not need, and a login form that did it
    // would be doing work on behalf of whoever was hammering it.
    statements = [];
    await get('/api/health');
    expect(sessionLookups()).toBe(0);

    statements = [];
    await post('/api/auth/login', undefined, { username: 'nobody' });
    expect(statements).toEqual([]);
  });

  it('do not resolve an actor even when a valid cookie is presented', async () => {
    // Public means nobody is asked, not "asked and ignored".
    statements = [];
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      cookies: owner.cookies,
    });
    expect(response.statusCode).toBe(200);
    expect(sessionLookups()).toBe(0);
  });
});

describe('everything that is not an API route', () => {
  it('is never answered with an authentication challenge', async () => {
    // The frontend has to load before anybody can sign in. A static asset or
    // the app shell met with a 401 would make signing in impossible, so the
    // declaration rule stops at `/api/` and the hook leaves these alone.
    for (const url of ['/', '/stock/some-variant', '/assets/nothing-here.css']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).not.toBe(401);
      expect(response.statusCode, url).not.toBe(403);
      expect(response.statusCode, url).not.toBe(500);
    }
  });

  it('answers an unknown API path with 404, session or not', async () => {
    // No route matched, so there is no policy to apply and nothing to leak.
    // The answer is the same whether or not a cookie was presented.
    expect((await get('/api/does-not-exist')).statusCode).toBe(404);
    expect((await get('/api/does-not-exist', owner)).statusCode).toBe(404);
  });
});

describe('an authenticated-only route', () => {
  it('returns the actor the hook resolved', async () => {
    const response = await get('/api/auth/me', employee);
    expect(response.statusCode).toBe(200);
    const body = authenticatedUserResponseSchema.parse(response.json());
    expect(body.user).toEqual({
      id: employee.user.id,
      username: employee.user.username,
      displayName: employee.user.displayName,
      role: 'EMPLOYEE',
      capabilities: ['catalog.read', 'inventory.read', 'inventory.receive'],
    });
  });

  it('resolves the session exactly once per request', async () => {
    // The handler reads `request.actor` rather than authenticating again. Two
    // lookups would be two answers that could disagree, at twice the cost.
    statements = [];
    expect((await get('/api/auth/me', owner)).statusCode).toBe(200);
    expect(sessionLookups()).toBe(1);
  });

  it('refuses every kind of unusable session with the same 401', async () => {
    const expired = await createTestSession(db.pool, {
      role: 'EMPLOYEE',
      username: 'expired.person',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      expiresAt: new Date('2026-08-02T12:00:00.000Z'),
    });
    const revoked = await createTestSession(db.pool, {
      role: 'EMPLOYEE',
      username: 'revoked.person',
      revokedAt: new Date('2026-08-03T10:00:00.000Z'),
    });
    const inactive = await createTestSession(db.pool, {
      role: 'EMPLOYEE',
      username: 'inactive.person',
      isActive: false,
    });

    expectUnauthenticated(await get('/api/auth/me'));
    expectUnauthenticated(
      await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: sessionCookies('not-a-real-token'),
      }),
    );
    expectUnauthenticated(await get('/api/auth/me', expired));
    expectUnauthenticated(await get('/api/auth/me', revoked));
    expectUnauthenticated(await get('/api/auth/me', inactive));
  });

  it('returns nothing secret', async () => {
    const response = await get('/api/auth/me', owner);
    expect(response.payload).not.toContain('argon2');
    expect(response.payload).not.toContain(owner.rawToken);
    expect(response.payload).not.toContain(owner.sessionId);
  });
});

describe('capability enforcement', () => {
  it('lets an employee read the catalog and stock', async () => {
    // `catalog.read` and `inventory.read` are what the job at the counter
    // needs, and they are what the seed grants.
    expect((await get(CATALOG, employee)).statusCode).toBe(200);
    expect((await get(LOCATIONS, employee)).statusCode).toBe(200);
  });

  it('refuses an employee the catalog write they were never granted', async () => {
    const before = await productCount();

    const response = await post(CATALOG, employee, aProduct());

    expectForbidden(response);
    expect(await productCount()).toBe(before);
    expect(await operationCount()).toBe(0);
  });

  it('lets an owner do everything currently declared', async () => {
    expect((await get(CATALOG, owner)).statusCode).toBe(200);
    expect((await get(LOCATIONS, owner)).statusCode).toBe(200);
    expect((await post(CATALOG, owner, aProduct())).statusCode).toBe(201);
  });

  it('lets a manager do everything the seed grants them', async () => {
    expect((await get(CATALOG, manager)).statusCode).toBe(200);
    expect((await get(LOCATIONS, manager)).statusCode).toBe(200);
    expect(
      (await post(CATALOG, manager, { ...aProduct(), name: 'Manager Product' })).statusCode,
    ).toBe(201);
  });

  it('never runs the handler of a route it denies', async () => {
    // `inventory.adjust` is withheld from an employee. The handler counts its
    // own entries, so this is not an inference from the status code.
    expectForbidden(await post(GUARDED, employee));
    expect(guardedHandlerCalls).toBe(0);

    expect((await post(GUARDED, owner)).statusCode).toBe(200);
    expect(guardedHandlerCalls).toBe(1);
  });

  it('says nothing about who does hold the capability', async () => {
    const response = await post(CATALOG, employee, aProduct());
    const said = response.payload.toLowerCase();
    for (const giveaway of ['catalog.write', 'owner', 'manager', 'role', 'capabilit']) {
      expect(said, `leaked "${giveaway}"`).not.toContain(giveaway);
    }
  });
});

describe('authentication versus authorization, on one route', () => {
  it('distinguishes not signed in from not permitted', async () => {
    // The remedy differs: one is fixed by signing in, the other by asking the
    // owner. A 404 for either — a common way to hide endpoints — would send
    // somebody looking for a page that exists.
    expectUnauthenticated(await post(CATALOG, undefined, aProduct()));
    expectUnauthenticated(
      await app.inject({
        method: 'POST',
        url: CATALOG,
        headers: { 'content-type': 'application/json' },
        cookies: sessionCookies('a-token-that-matches-no-row'),
        payload: JSON.stringify(aProduct()),
      }),
    );
    expectForbidden(await post(CATALOG, employee, aProduct()));
    expect((await post(CATALOG, owner, aProduct())).statusCode).toBe(201);
  });

  it('writes nothing on either refusal', async () => {
    const before = await productCount();
    await post(CATALOG, undefined, aProduct());
    await post(CATALOG, employee, aProduct());
    expect(await productCount()).toBe(before);
    expect(await operationCount()).toBe(0);
  });

  it('answers both in the standard envelope, with a request id', async () => {
    for (const response of [
      await post(CATALOG, undefined, aProduct()),
      await post(CATALOG, employee, aProduct()),
    ]) {
      const body = errorBodySchema.parse(response.json());
      expect(response.headers[REQUEST_ID_HEADER]).toBe(body.error.requestId);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
    }
  });
});

describe('a permission change lands on the next request', () => {
  it('takes effect when a grant is removed and restored, on the same session', async () => {
    expect((await get(CATALOG, employee)).statusCode).toBe(200);

    await db.pool.query(
      `DELETE FROM role_capabilities WHERE role = 'EMPLOYEE' AND capability = 'catalog.read'`,
    );
    expectForbidden(await get(CATALOG, employee));

    await db.pool.query(
      `INSERT INTO role_capabilities (role, capability) VALUES ('EMPLOYEE', 'catalog.read')`,
    );
    expect((await get(CATALOG, employee)).statusCode).toBe(200);

    // Same cookie throughout. Nobody signed in again, and no session row moved.
    expect((await sessions(db.pool)).some((row) => row.id === employee.sessionId)).toBe(true);
  });

  it('takes effect when the person is promoted', async () => {
    expectForbidden(await post(CATALOG, employee, aProduct()));

    await db.pool.query(`UPDATE users SET role = 'MANAGER' WHERE id = $1`, [employee.user.id]);

    expect(
      (await post(CATALOG, employee, { ...aProduct(), name: 'After Promotion' })).statusCode,
    ).toBe(201);
    expect((await get('/api/auth/me', employee)).json().user.role).toBe('MANAGER');
  });

  it('takes effect when the person is deactivated', async () => {
    // Not 403 — 401. A deactivated account is not a person with fewer
    // permissions; there is nobody signed in at all.
    expect((await get(CATALOG, employee)).statusCode).toBe(200);

    await db.pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [employee.user.id]);

    expectUnauthenticated(await get(CATALOG, employee));
    expectUnauthenticated(await get('/api/auth/me', employee));
  });
});

describe('the actor is the session, and only the session', () => {
  it('ignores a user id in the request body', async () => {
    const response = await post(WHOAMI, employee, {
      userId: owner.user.id,
      id: owner.user.id,
      actor: { id: owner.user.id, role: 'OWNER' },
      role: 'OWNER',
      capabilities: ['identity.manage'],
    });

    expect(response.statusCode).toBe(200);
    const { actor } = response.json() as {
      actor: { id: string; role: string; capabilities: string[] };
    };
    expect(actor.id).toBe(employee.user.id);
    expect(actor.role).toBe('EMPLOYEE');
    expect(actor.capabilities).not.toContain('identity.manage');
  });

  it('ignores forged identity headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: WHOAMI,
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.user.id,
        'x-ekon-user': owner.user.username,
        'x-ekon-role': 'OWNER',
        'x-ekon-capabilities': 'identity.manage',
        authorization: `Bearer ${owner.rawToken}`,
      },
      cookies: employee.cookies,
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(200);
    const { actor } = response.json() as { actor: { id: string; role: string } };
    expect(actor.id).toBe(employee.user.id);
    expect(actor.role).toBe('EMPLOYEE');
  });

  it('does not accept a bearer token in place of a cookie', async () => {
    // There is one credential and one place it lives. An Authorization header
    // is not a second door.
    const response = await app.inject({
      method: 'POST',
      url: WHOAMI,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.rawToken}` },
      payload: JSON.stringify({}),
    });
    expectUnauthenticated(response);
  });

  it('gives a capability-protected handler the same trusted actor', async () => {
    const response = await post(GUARDED, owner);
    expect(response.statusCode).toBe(200);
    expect(guardedHandlerCalls).toBe(1);
  });
});
