import {
  authenticatedUserResponseSchema,
  type AuthenticatedUser,
  type LoginRequest,
} from '@ekon/shared';
import { api, ApiError } from '../lib/api.js';

/**
 * The three calls that make up browser authentication, over the one API client.
 *
 * Nothing here reads, writes, or names a cookie. The session token lives in an
 * `HttpOnly` cookie that JavaScript cannot see; `credentials: 'same-origin'` in
 * the API client is the whole of the client's part in carrying it. There is no
 * token in memory, no `Authorization` header, and nothing to persist.
 *
 * All three responses are parsed with the shared schemas rather than asserted
 * with a type parameter. This is the one boundary where the shape decides what
 * the person is allowed to see, so a server that answered something unexpected
 * should fail loudly here instead of rendering a half-formed user.
 */

/** The bootstrap query's key. Exported so signing in and out can address it. */
export const AUTH_ME_QUERY_KEY = ['auth', 'me'] as const;

export function isAuthQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === AUTH_ME_QUERY_KEY[0];
}

/**
 * Who the server says we are, or `null` when nobody is signed in.
 *
 * A 401 is an *answer*, not a failure: it is the expected response on a first
 * visit and after a session ends, and modelling it as data is what keeps the
 * bootstrap from retrying it, reporting it as a broken server, or looping. Any
 * other failure — a dropped connection, a 500 — is thrown, because those mean
 * we do not know whether anybody is signed in, which is a different screen.
 */
export async function getCurrentUser(signal?: AbortSignal): Promise<AuthenticatedUser | null> {
  try {
    const body = await api.get<unknown>('/api/auth/me', signal);
    return authenticatedUserResponseSchema.parse(body).user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Sign in. The request carries a username and a password and nothing else — no
 * role, no capability list, no session lifetime. The server decides all of it
 * from the credential, and its login schema is strict, so anything extra would
 * be a 400 rather than a field quietly ignored.
 */
export async function login(credentials: LoginRequest): Promise<AuthenticatedUser> {
  const body = await api.postWithoutOperationId<unknown>('/api/auth/login', credentials);
  return authenticatedUserResponseSchema.parse(body).user;
}

/**
 * Sign out. Answers 204 with no body — including when the session was already
 * expired or revoked, which is why the caller may treat success as "the server
 * session is gone" without asking what the cookie contained.
 */
export async function logout(): Promise<void> {
  await api.postWithoutOperationId<void>('/api/auth/logout');
}
