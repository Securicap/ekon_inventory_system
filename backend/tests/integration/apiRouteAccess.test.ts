import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { RouteAccessDeclarationError } from '../../src/modules/identity/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * The rule that makes the protection exhaustive: an API route that does not say
 * who may call it does not exist.
 *
 * This is the part of authorization that has to survive people. Every check in
 * the enforcement hook is worthless against the endpoint somebody adds next
 * year and forgets to protect, and no code review reliably catches an *absence*.
 * So the absence is what fails: registering an `/api/` route without a
 * declaration throws while routes are being registered, and the application
 * never finishes starting.
 *
 * Registration is synchronous, so these assertions are `expect(() => ...)`
 * rather than a request that comes back 500. No database is touched — the
 * failure happens before anything is asked of it.
 *
 * Each test gets its own instance: Fastify refuses to add a route once an
 * instance has served a request, and a rejected registration must not leave the
 * next test's application half-built.
 */

const NOOP = async (): Promise<{ ok: true }> => ({ ok: true });

let db: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  // No migration: nothing here reaches persistence, and route registration
  // never queries.
  db = await createTestDatabase({ migrate: false });
});

beforeEach(async () => {
  app = await buildApp({
    config: { ...loadConfig(), LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock: fixedClock(new Date('2026-08-03T12:00:00.000Z')),
  });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await db.drop();
});

describe('an API route that declares nothing', () => {
  it('cannot be registered', () => {
    expect(() => app.get('/api/forgotten', NOOP)).toThrow(RouteAccessDeclarationError);
  });

  it('cannot be registered with an empty config either', () => {
    expect(() => app.post('/api/also-forgotten', { config: {} }, NOOP)).toThrow(
      RouteAccessDeclarationError,
    );
  });

  it('names the route and the three things it could have said', () => {
    // The message is the whole value of this check: it is read by somebody who
    // has just added a route and does not yet know this rule exists.
    expect(() => app.get('/api/nameless', NOOP)).toThrow(/Route GET \/api\/nameless/);
    expect(() => app.get('/api/nameless', NOOP)).toThrow(/auth: 'public'/);
    expect(() => app.get('/api/nameless', NOOP)).toThrow(/auth: 'authenticated'/);
    expect(() => app.get('/api/nameless', NOOP)).toThrow(/capability/);
  });
});

describe('an API route that contradicts itself', () => {
  it('cannot declare public and a capability', () => {
    // Public means nobody is identified; a capability means somebody is. One of
    // the two would have to be ignored, and whichever it was would surprise
    // somebody.
    expect(() =>
      app.get('/api/both', { config: { auth: 'public', capability: 'inventory.read' } }, NOOP),
    ).toThrow(RouteAccessDeclarationError);
  });

  it('cannot declare authenticated-only and a capability', () => {
    // Not a contradiction so much as a duplication: a capability already
    // requires a session. Two statements of one fact can drift apart.
    expect(() =>
      app.get(
        '/api/duplicated',
        { config: { auth: 'authenticated', capability: 'inventory.read' } },
        NOOP,
      ),
    ).toThrow(/declares both/);
  });

  it('cannot declare a capability that does not exist', () => {
    // A capability outside the vocabulary is one no actor can hold, so the
    // route would answer 403 forever — a silent failure that looks like a
    // permissions problem.
    expect(() =>
      // Cast: the type already forbids this. The runtime check is for configs
      // assembled dynamically, where the type is not there to help.
      app.get('/api/invented', { config: { capability: 'catalog.destroy' as never } }, NOOP),
    ).toThrow(/not a known capability/);
  });

  it('cannot declare an auth mode that does not exist', () => {
    expect(() =>
      app.get('/api/typo', { config: { auth: 'authenticated-ish' as never } }, NOOP),
    ).toThrow(/not 'public' or 'authenticated'/);
  });
});

describe('a route that declares itself properly', () => {
  it('registers as public, authenticated, or capability-protected', () => {
    expect(() => app.get('/api/ok-public', { config: { auth: 'public' } }, NOOP)).not.toThrow();
    expect(() =>
      app.get('/api/ok-authenticated', { config: { auth: 'authenticated' } }, NOOP),
    ).not.toThrow();
    expect(() =>
      app.get('/api/ok-capability', { config: { capability: 'catalog.read' } }, NOOP),
    ).not.toThrow();
  });

  it('lets Fastify generate the matching HEAD route without complaint', async () => {
    // Fastify creates a HEAD for every GET, carrying the same config object, so
    // the generated route passes on the strength of the declaration its GET
    // already made. Nothing is exempted to achieve that.
    expect(() => app.get('/api/with-head', { config: { auth: 'public' } }, NOOP)).not.toThrow();

    const head = await app.inject({ method: 'HEAD', url: '/api/with-head' });
    expect(head.statusCode).toBe(200);
  });

  it('still requires a hand-written HEAD route to declare its own access', () => {
    // The generated-HEAD allowance is not a hole: a HEAD somebody writes by
    // hand is an endpoint like any other.
    expect(() => app.head('/api/bare-head', NOOP)).toThrow(RouteAccessDeclarationError);
  });
});

describe('routes that are not the API', () => {
  it('may exist without an access declaration', () => {
    // The static frontend, the single-page fallback, and anything else served
    // to a browser that has not signed in yet. The rule is about `/api/`,
    // because that is where the data is.
    expect(() => app.get('/not-api', NOOP)).not.toThrow();
    expect(() => app.get('/', NOOP)).not.toThrow();
    expect(() => app.get('/assets/thing.css', NOOP)).not.toThrow();
  });

  it('are still held to a coherent declaration if they make one', () => {
    expect(() =>
      app.get(
        '/not-api-contradictory',
        { config: { auth: 'public', capability: 'audit.read' } },
        NOOP,
      ),
    ).toThrow(RouteAccessDeclarationError);
  });
});
