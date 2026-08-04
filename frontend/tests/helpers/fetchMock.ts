import { vi } from 'vitest';
import type { ErrorCode } from '@ekon/shared';

/**
 * A tiny router in front of `fetch`, so a test can say what each endpoint
 * answers and then read back exactly what the application asked for.
 *
 * It records requests rather than cookies. Nothing here mocks
 * `document.cookie`, and no test asserts a token value: the session cookie is
 * `HttpOnly`, so browser JavaScript cannot read it, and a test that pretended
 * otherwise would be testing a browser we do not run in. What the application
 * can be held to is that every request carries `credentials: 'same-origin'` —
 * that is asserted, from the recorded init.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

/** Produces the next response for a route. Throwing simulates a dead network. */
export type Responder = () => Response | Promise<Response>;

export interface FetchMock {
  /** Every request the application made, in order. */
  requests: RecordedRequest[];
  /** Requests to one `"METHOD /path"` route. */
  to(route: string): RecordedRequest[];
}

/**
 * Routes are keyed `"GET /api/auth/me"`. A route may be given a list of
 * responders to answer a sequence of calls; the last one repeats, so
 * `[offline(), ok(body)]` is "fails, then works from then on".
 *
 * `/api/health` answers by default because the landing screen reads it, and no
 * authentication test is about the health panel.
 */
export function mockApi(routes: Record<string, Responder | Responder[]>): FetchMock {
  const handlers = new Map<string, Responder[]>();
  const calls = new Map<string, number>();
  const requests: RecordedRequest[] = [];

  const withDefaults: Record<string, Responder | Responder[]> = {
    'GET /api/health': json({
      status: 'ok',
      version: 'test',
      schemaVersion: '0008',
      database: 'up',
      time: '2026-08-02T12:00:00.000Z',
    }),
    ...routes,
  };

  for (const [route, responder] of Object.entries(withDefaults)) {
    handlers.set(route, Array.isArray(responder) ? responder : [responder]);
  }

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const url = String(input);
      const route = `${method} ${url}`;

      requests.push({
        method,
        url,
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        credentials: init.credentials,
      });

      const responders = handlers.get(route);
      if (!responders || responders.length === 0) {
        return Promise.resolve(apiFailure('NOT_FOUND', 404)() as Response);
      }

      const index = calls.get(route) ?? 0;
      calls.set(route, index + 1);
      const responder = responders[Math.min(index, responders.length - 1)];
      return Promise.resolve(responder!());
    }),
  );

  return {
    requests,
    to: (route) => requests.filter((request) => `${request.method} ${request.url}` === route),
  };
}

export function json(body: unknown, status = 200): Responder {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

/** A 204, which is what signing out answers. */
export function noContent(): Responder {
  return () => new Response(null, { status: 204 });
}

/** The structured error envelope every failing route returns. */
export function apiFailure(code: ErrorCode, status: number, requestId = 'req-test'): Responder {
  return () =>
    new Response(JSON.stringify({ error: { code, message: `English: ${code}`, requestId } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

/** The request never reached the server. Distinct from any status code. */
export function offline(): Responder {
  return () => {
    throw new TypeError('Failed to fetch');
  };
}

/** A response the test resolves by hand, to observe an in-flight state. */
export function deferred(): { responder: Responder; resolve: (responder: Responder) => void } {
  let release: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return {
    responder: () => pending,
    resolve: (responder) => {
      void Promise.resolve(responder()).then(release);
    },
  };
}
