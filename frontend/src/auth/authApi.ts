import {
  authenticatedUserResponseSchema,
  currentUserResponseSchema,
  setupOwnerRequestSchema,
  setupOwnerResponseSchema,
  type AuthenticatedUser,
  type LoginRequest,
  type SetupOwnerRequest,
} from '@ekon/shared';
import { api, ApiError } from '../lib/api.js';

/**
 * The four calls that make up browser authentication, over the one API client.
 *
 * Nothing here reads, writes, or names a cookie. The session token lives in an
 * `HttpOnly` cookie that JavaScript cannot see; `credentials: 'same-origin'` in
 * the API client is the whole of the client's part in carrying it. There is no
 * token in memory, no `Authorization` header, and nothing to persist.
 *
 * Every response is parsed with the shared schemas rather than asserted with a
 * type parameter. This is the one boundary where the shape decides what
 * the person is allowed to see, so a server that answered something unexpected
 * should fail loudly here instead of rendering a half-formed user.
 */

/** The bootstrap query's key. Exported so signing in and out can address it. */
export const AUTH_ME_QUERY_KEY = ['auth', 'me'] as const;

export function isAuthQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === AUTH_ME_QUERY_KEY[0];
}

/**
 * What the bootstrap can learn: a signed-in person, an installation that has no
 * accounts yet, or nobody.
 *
 * Three states rather than `user | null`, because "nobody is signed in" and
 * "there is nobody to sign in as" lead to different screens and only the server
 * can tell them apart. Modelled as data rather than as an error for the same
 * reason a 401 is: neither is a failure, and neither should be retried.
 */
export type CurrentUser =
  | { status: 'authenticated'; user: AuthenticatedUser }
  | { status: 'setup' }
  | { status: 'anonymous' };

/**
 * Who the server says we are.
 *
 * A 401 is an *answer*, not a failure: it is the expected response on a first
 * visit and after a session ends, and modelling it as data is what keeps the
 * bootstrap from retrying it, reporting it as a broken server, or looping. Any
 * other failure — a dropped connection, a 500 — is thrown, because those mean
 * we do not know whether anybody is signed in, which is a different screen.
 *
 * A brand-new installation answers `200 { state: 'setup' }` instead of `401`,
 * which is what puts the first-run screen in front of the person who installed
 * it rather than a login form they cannot use.
 */
export async function getCurrentUser(signal?: AbortSignal): Promise<CurrentUser> {
  try {
    const body = currentUserResponseSchema.parse(await api.get<unknown>('/api/auth/me', signal));
    return 'user' in body ? { status: 'authenticated', user: body.user } : { status: 'setup' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { status: 'anonymous' };
    throw error;
  }
}

/**
 * Create the first owner of a new installation.
 *
 * Public, because on a database with no users there is nobody to authenticate
 * as — and refused the moment one exists, with `SETUP_COMPLETE`. The browser's
 * part is only to send three fields and show what came back; the guarantee that
 * exactly one owner can ever be created this way is a table lock in the server,
 * not a disabled button here.
 *
 * Parsed with the shared schema on the way out, so a request that tried to
 * state a role, an id, or an active flag would fail here rather than be
 * silently dropped. **No operation id**: this is not a ledger command, and a
 * repeat is answered `409` rather than replayed.
 *
 * Returns the owner that now exists. No session comes back with it — the person
 * signs in with the password they just chose, which proves it works before the
 * shop depends on it.
 */
export async function setUpFirstOwner(request: SetupOwnerRequest): Promise<AuthenticatedUser> {
  const body = setupOwnerRequestSchema.parse(request);
  const response = await api.postWithoutOperationId<unknown>('/api/setup/owner', body);
  return setupOwnerResponseSchema.parse(response).user;
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
