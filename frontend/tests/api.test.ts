import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATION_ID_HEADER } from '@ekon/shared';
import { api, ApiError, NetworkError } from '../src/lib/api.js';

/**
 * What the API client puts on the wire.
 *
 * The client identifies the *command* — a retry-stable operation id — and
 * nothing else. It does not identify the browser: an employee may sign in from
 * whichever computer is free, and which machine that is has no business
 * meaning. Attribution is the authenticated user's, carried by the session
 * cookie that `credentials: 'same-origin'` sends.
 */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: string | undefined;
}

let captured: CapturedRequest[] = [];

function mockFetch(respond: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
        credentials: init.credentials,
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      return Promise.resolve(respond());
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request headers', () => {
  it('sends no browser or device identifier on a read', async () => {
    mockFetch(() => jsonResponse([{ id: '1' }]));
    await api.get('/api/inventory/locations');

    const headerNames = Object.keys(captured[0]!.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('x-ekon-device-id');
    // Nothing that fingerprints the machine under another name, either.
    expect(headerNames.some((name) => /device|machine|terminal|fingerprint/.test(name))).toBe(
      false,
    );
  });

  it('sends no browser or device identifier on a write', async () => {
    mockFetch(() => jsonResponse({ id: '1' }, 201));
    await api.post('/api/products', { name: 'Rice' }, 'operation-1');

    const headerNames = Object.keys(captured[0]!.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('x-ekon-device-id');
  });

  it('carries the operation id on a state-changing request', async () => {
    mockFetch(() => jsonResponse({ id: '1' }, 201));
    await api.post('/api/products', { name: 'Rice' }, 'operation-42');

    expect(captured[0]!.headers[OPERATION_ID_HEADER]).toBe('operation-42');
    expect(captured[0]!.headers['content-type']).toBe('application/json');
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.body).toBe(JSON.stringify({ name: 'Rice' }));
  });

  it('sends no operation id when signing in or out', async () => {
    // An operation id exists so a retried *movement* is posted once. Signing in
    // is not a movement — a second attempt must mint a second session, not
    // replay the first — and the auth routes write no `operations` row, so the
    // header would claim an idempotency that does not exist.
    mockFetch(() => jsonResponse({ user: { id: '1' } }));
    await api.postWithoutOperationId('/api/auth/login', { username: 'marie.j', password: 'x' });

    expect(captured[0]!.headers[OPERATION_ID_HEADER]).toBeUndefined();
    expect(captured[0]!.credentials).toBe('same-origin');
    expect(captured[0]!.method).toBe('POST');
  });

  it('sends no body and no content type when signing out', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await api.postWithoutOperationId('/api/auth/logout');

    expect(captured[0]!.body).toBeUndefined();
    expect(captured[0]!.headers['content-type']).toBeUndefined();
    expect(captured[0]!.headers[OPERATION_ID_HEADER]).toBeUndefined();
  });

  it('sends no authorization header: the session travels in a cookie only', async () => {
    mockFetch(() => jsonResponse({}));
    await api.get('/api/auth/me');

    const headerNames = Object.keys(captured[0]!.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('cookie');
  });

  it('sends no operation id or content type on a read', async () => {
    mockFetch(() => jsonResponse([]));
    await api.get('/api/inventory/locations');

    expect(captured[0]!.headers[OPERATION_ID_HEADER]).toBeUndefined();
    expect(captured[0]!.headers['content-type']).toBeUndefined();
  });

  it('sends same-origin credentials, so the session cookie travels', async () => {
    mockFetch(() => jsonResponse([]));
    await api.get('/api/inventory/locations');
    expect(captured[0]!.credentials).toBe('same-origin');

    mockFetch(() => jsonResponse({}, 201));
    await api.post('/api/products', {}, 'operation-2');
    expect(captured[1]!.credentials).toBe('same-origin');
  });

  it('writes nothing to localStorage while making a request', async () => {
    // The removed device id lived in localStorage. Nothing replaced it.
    window.localStorage.clear();
    mockFetch(() => jsonResponse([]));
    await api.get('/api/inventory/locations');
    expect(window.localStorage.length).toBe(0);
  });
});

describe('responses', () => {
  it('returns the parsed body of a successful read', async () => {
    mockFetch(() => jsonResponse([{ id: '1', name: 'Main Store' }]));
    await expect(api.get('/api/inventory/locations')).resolves.toEqual([
      { id: '1', name: 'Main Store' },
    ]);
  });

  it('raises a structured ApiError from a structured error body', async () => {
    mockFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'INSUFFICIENT_STOCK',
            message: 'Insufficient stock',
            requestId: 'req-1',
          },
        },
        422,
      ),
    );

    const failure = await api.post('/api/x', {}, 'operation-3').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: 'INSUFFICIENT_STOCK', status: 422, requestId: 'req-1' });
  });

  it('distinguishes a request that never reached the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(api.get('/api/inventory/locations')).rejects.toBeInstanceOf(NetworkError);
  });
});
