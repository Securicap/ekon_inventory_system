import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { healthResponseSchema } from '@ekon/shared';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

describe('GET /api/health', () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent', APP_VERSION: 'test-build' },
      pool: db.pool,
      clock: fixedClock(new Date('2026-08-02T12:00:00.000Z')),
    });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('reports ok and the applied schema version', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    // Parsing against the shared schema proves the contract the frontend
    // relies on, not just that some JSON came back.
    const body = healthResponseSchema.parse(response.json());
    expect(body.status).toBe('ok');
    expect(body.database).toBe('up');
    expect(body.version).toBe('test-build');
    expect(body.schemaVersion).toBe('0001');
    expect(body.time).toBe('2026-08-02T12:00:00.000Z');
  });

  it('echoes a request id on every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('returns a structured json error for an unknown api route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('serves the app shell for an unknown non-api route when a build is present', async () => {
    // Client-side routing must survive a hard refresh on a deep link. When no
    // frontend build exists (API-only development), a JSON 404 is correct.
    const response = await app.inject({ method: 'GET', url: '/stock/some-variant' });

    if (existsSync(path.resolve(process.cwd(), loadConfig().STATIC_DIR))) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    } else {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });
});
