import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticatedUserResponseSchema,
  currentUserResponseSchema,
  DEFAULT_ROLE_CAPABILITIES,
  setupOwnerResponseSchema,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * First-run setup: the one way an installation with no accounts gets an owner
 * from the screen in front of whoever installed it.
 *
 * The bootstrap problem, restated for a product that is installed rather than
 * deployed. There is nobody to authenticate as on an empty database, and on a
 * shop computer there is no operator with a shell to run
 * `npm run identity:create-owner` either — so a public route has to exist. What
 * makes that safe is that it refuses unless `users` is **empty**, re-checked
 * inside the transaction under a table lock, and that it can create nothing but
 * an `OWNER`.
 *
 * The route runs against `db.appPool`, the restricted connection an
 * installation uses, so the grants in 0014 are exercised by it like everything
 * else.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple';

const OWNER = {
  username: 'marie.j',
  displayName: 'Marie Joseph',
  password: PASSWORD,
};

describe('first-run owner setup', () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent' },
      pool: db.appPool,
      clock: fixedClock(NOW),
    });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  beforeEach(async () => {
    // Every test starts from a machine somebody has just installed. Deleted as
    // the owner, because the application role deliberately cannot.
    await db.pool.query('DELETE FROM sessions');
    await db.pool.query('DELETE FROM users');
  });

  const setUp = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/setup/owner',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

  const me = () => app.inject({ method: 'GET', url: '/api/auth/me' });

  describe('GET /api/auth/me on an installation with no accounts', () => {
    it('says the installation needs setting up, rather than refusing', async () => {
      // A 401 here would put a login form in front of somebody with no account
      // to type into it and no way to create one: a dead end.
      const response = await me();
      expect(response.statusCode).toBe(200);
      expect(currentUserResponseSchema.parse(response.json())).toEqual({ state: 'setup' });
    });

    it('says nothing else at all', async () => {
      // No version, no profile, no count of anything. The only fact it gives an
      // anonymous caller is that there are no accounts, which stops being true
      // the moment one exists.
      expect(Object.keys((await me()).json() as object)).toEqual(['state']);
    });

    it('goes back to 401 as soon as an owner exists', async () => {
      await setUp(OWNER);
      const response = await me();
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });

    it('is not fooled by a deactivated user', async () => {
      // "No active owner" and "no users" are different questions, and setup
      // turns on the stricter one. An installation holding people is one where
      // creating an account is a signed-in workflow.
      await setUp(OWNER);
      await db.pool.query(`UPDATE users SET is_active = false`);

      const response = await me();
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/setup/owner', () => {
    it('creates the owner and returns them, with their real capabilities', async () => {
      const response = await setUp(OWNER);
      expect(response.statusCode).toBe(201);

      const body = setupOwnerResponseSchema.parse(response.json());
      expect(body.user.username).toBe('marie.j');
      expect(body.user.displayName).toBe('Marie Joseph');
      expect(body.user.role).toBe('OWNER');
      // Read from `role_capabilities`, not assembled from a constant — so this
      // is the same answer every request resolves.
      expect(body.user.capabilities).toEqual([...(DEFAULT_ROLE_CAPABILITIES.OWNER ?? [])].sort());
      expect(body.user.capabilities).toContain('system.manage');
    });

    it('does not sign anybody in', async () => {
      // Creating an account and holding a session are different things. The
      // person types the password they just chose into the ordinary login form,
      // which proves it works while they are still standing there — and there
      // is no self-service reset if it does not.
      const response = await setUp(OWNER);
      expect(response.headers['set-cookie']).toBeUndefined();

      expect((await me()).statusCode).toBe(401);
    });

    it('returns no credential of any kind', async () => {
      const body = (await setUp(OWNER)).json() as { user: Record<string, unknown> };
      expect(Object.keys(body.user).sort()).toEqual([
        'capabilities',
        'displayName',
        'id',
        'role',
        'username',
      ]);
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
      expect(JSON.stringify(body)).not.toContain('argon2');
    });

    it('creates an account that can actually sign in', async () => {
      await setUp(OWNER);

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username: 'marie.j', password: PASSWORD }),
      });

      expect(login.statusCode).toBe(200);
      expect(authenticatedUserResponseSchema.parse(login.json()).user.role).toBe('OWNER');
    });

    it('normalizes the username the way signing in will', async () => {
      const response = await setUp({ ...OWNER, username: '  Marie.J  ' });
      expect(response.statusCode).toBe(201);
      expect(setupOwnerResponseSchema.parse(response.json()).user.username).toBe('marie.j');
    });

    it('answers 409 SETUP_COMPLETE once anybody exists', async () => {
      await setUp(OWNER);

      const second = await setUp({ ...OWNER, username: 'other.person' });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: { code: 'SETUP_COMPLETE' } });
    });

    it('refuses even when the only user is an employee somebody else created', async () => {
      // The rule is "no users", not "no owner". A database that already holds
      // people is one where creating an account is somebody's authenticated
      // workflow, and an unauthenticated route must not reopen on it.
      await db.pool.query(
        `INSERT INTO users (id, username, display_name, password_hash, role, is_active,
                            created_at, updated_at)
         VALUES (gen_random_uuid(), 'pierre', 'Pierre', '$argon2id$v=19$m=1,t=1,p=1$x$y',
                 'EMPLOYEE', true, now(), now())`,
      );

      const response = await setUp(OWNER);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'SETUP_COMPLETE' } });
    });

    it('creates exactly one owner when two requests arrive together', async () => {
      // Two browser tabs on the first-run screen, or a tab and a reload. The
      // guarantee is `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` plus a
      // re-check of count(*) = 0 *inside* the transaction: without it both
      // would look, both would see nothing, and both would write — and the
      // username UNIQUE would not catch it, because the two owners have
      // different names.
      const [first, second] = await Promise.all([
        setUp(OWNER),
        setUp({ ...OWNER, username: 'pierre.l', displayName: 'Pierre Louis' }),
      ]);

      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([201, 409]);

      const { rows } = await db.pool.query<{ count: number }>(`SELECT count(*) FROM users`);
      expect(rows[0]?.count).toBe(1);
    });

    it('creates exactly one owner when five requests arrive together', async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          setUp({ ...OWNER, username: `owner.${index}`, displayName: `Owner ${index}` }),
        ),
      );

      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(4);

      const { rows } = await db.pool.query<{ count: number }>(`SELECT count(*) FROM users`);
      expect(rows[0]?.count).toBe(1);
    });
  });

  describe('what the setup request may say', () => {
    it('refuses a request that tries to state a role', async () => {
      // This route creates owners and creates nothing else. A strict schema is
      // what makes an attempt a 400 naming the field, rather than a value
      // quietly ignored on a public route that hands out every capability.
      const response = await setUp({ ...OWNER, role: 'EMPLOYEE' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });

    it('refuses an id, an active flag, or a capability list', async () => {
      for (const extra of [
        { id: '00000000-0000-0000-0000-000000000001' },
        { isActive: false },
        { capabilities: ['system.manage'] },
        { passwordHash: '$argon2id$v=19$m=1,t=1,p=1$x$y' },
      ]) {
        const response = await setUp({ ...OWNER, ...extra });
        expect(response.statusCode, JSON.stringify(extra)).toBe(400);
      }
    });

    it('refuses a short password, and creates nobody', async () => {
      const response = await setUp({ ...OWNER, password: 'short' });
      expect(response.statusCode).toBe(400);

      const { rows } = await db.pool.query<{ count: number }>(`SELECT count(*) FROM users`);
      expect(rows[0]?.count).toBe(0);
    });

    it('refuses a username that is not one', async () => {
      const response = await setUp({ ...OWNER, username: 'Marie Joseph!' });
      expect(response.statusCode).toBe(400);
    });

    it('never echoes the password back, whatever it refuses', async () => {
      const response = await setUp({ ...OWNER, username: '!!' });
      expect(response.body).not.toContain(PASSWORD);
    });
  });
});
