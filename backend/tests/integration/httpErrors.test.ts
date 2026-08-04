import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema, REQUEST_ID_HEADER } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * The global HTTP error boundary. Malformed JSON is rejected by Fastify before a
 * route ever runs; it must surface as a structured 400, not an unexpected 500,
 * while genuine server faults still return 500.
 */
describe('global HTTP error handling', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  /**
   * The route these tests aim at is capability-protected, and authentication
   * runs before the body is parsed — so an anonymous malformed request is a 401
   * and never reaches the parser at all (asserted below). To test the parser
   * boundary, these requests are signed in.
   */
  let owner: TestSession;

  const url = '/api/catalog/products';
  const json = { 'content-type': 'application/json' };
  const MALFORMED = '{"name":"Bottled Water",';

  beforeAll(async () => {
    // Migrated, unlike before: these paths still never reach catalog
    // persistence, but reaching them at all now requires a session, and a
    // session is a row.
    db = await createTestDatabase();
    owner = await createTestSession(db.pool);
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent' },
      pool: db.pool,
      clock: fixedClock(new Date('2026-08-03T12:00:00.000Z')),
    });
    // Smallest seam for the unexpected-error path: a test-only route that
    // throws. It is registered on the test instance, never in production code —
    // and it has to declare its access like any other API route, which is the
    // fail-closed rule working on a route nobody thought about.
    app.post('/api/_test/boom', { config: { auth: 'authenticated' } }, async () => {
      throw new Error('unexpected boom with secret internal detail');
    });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('returns a structured 400 VALIDATION_FAILED for a malformed JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: json,
      cookies: owner.cookies,
      payload: MALFORMED,
    });
    expect(res.statusCode).toBe(400);
    const body = errorBodySchema.parse(res.json());
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toBe('Malformed JSON request body');
    expect(body.error.requestId).toBeTruthy();
  });

  it('keeps the x-request-id header consistent with the body requestId', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: json,
      cookies: owner.cookies,
      payload: MALFORMED,
    });
    const body = errorBodySchema.parse(res.json());
    expect(res.headers[REQUEST_ID_HEADER]).toBe(body.error.requestId);
  });

  it('echoes a caller-supplied request id', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { ...json, [REQUEST_ID_HEADER]: 'caller-req-123' },
      cookies: owner.cookies,
      payload: MALFORMED,
    });
    expect(res.headers[REQUEST_ID_HEADER]).toBe('caller-req-123');
    expect(errorBodySchema.parse(res.json()).error.requestId).toBe('caller-req-123');
  });

  it('does not expose parser internals, stack traces, or the request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: json,
      cookies: owner.cookies,
      payload: MALFORMED,
    });
    const raw = res.payload;
    // No echo of the submitted body, no parser/exception internals.
    expect(raw).not.toContain('Bottled Water');
    expect(raw).not.toMatch(/SyntaxError|JSON\.parse|FST_ERR|Unexpected|\bat .+:\d+/i);
    // Only the three safe, documented fields are present.
    expect(Object.keys(errorBodySchema.parse(res.json()).error).sort()).toEqual([
      'code',
      'message',
      'requestId',
    ]);
  });

  it('treats an empty JSON body as the same client error', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: json,
      cookies: owner.cookies,
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBodySchema.parse(res.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('still routes valid JSON with invalid fields through the Zod validation path', async () => {
    // Well-formed JSON, but the schema rejects it: this must remain the existing
    // Zod path — a distinct message and field-level details — not the parser path.
    const res = await app.inject({
      method: 'POST',
      url,
      headers: json,
      cookies: owner.cookies,
      payload: JSON.stringify({ variants: [] }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string; details?: unknown } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toBe('Request validation failed');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('refuses an anonymous caller before parsing anything they sent', async () => {
    // Authentication runs in `onRequest`, before the body is read. A caller
    // with no session learns nothing about the shape of the request they got
    // wrong, and a malformed body from an anonymous client is never parsed.
    const res = await app.inject({ method: 'POST', url, headers: json, payload: MALFORMED });
    expect(res.statusCode).toBe(401);
    const body = errorBodySchema.parse(res.json());
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(res.payload).not.toContain('Bottled Water');
    expect(res.payload).not.toContain('Malformed');
  });

  it('still returns 500 INTERNAL for a genuine unexpected error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/_test/boom',
      headers: json,
      cookies: owner.cookies,
      payload: '{}',
    });
    expect(res.statusCode).toBe(500);
    const body = errorBodySchema.parse(res.json());
    expect(body.error.code).toBe('INTERNAL');
    // The raw thrown message must never reach the client.
    expect(res.payload).not.toContain('secret internal detail');
  });
});
