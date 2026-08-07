import {
  createUserRequestSchema,
  createUserResponseSchema,
  type CreatedUser,
  type CreateUserRequest,
} from '@ekon/shared';
import { api } from './api.js';

/**
 * Creating an account: one call, over the one API client.
 *
 * As small as the other endpoint modules, and for the same reason — no fetch,
 * no headers, no credentials, no error translation. `lib/api.ts` owns all of
 * that, including `credentials: 'same-origin'`, which is how the caller's own
 * session cookie is carried and therefore how the server knows they hold
 * `identity.manage`.
 *
 * **No operation id, and deliberately so.** `postWithoutOperationId` exists for
 * calls that are not ledger commands, and this is one: the header makes a
 * retried *movement* post once, and creating an account has no such problem to
 * solve. A repeat is a duplicate username, which the database refuses on its
 * own, and sending an id would claim an idempotency the route does not
 * implement — the second attempt would be answered `409`, not replayed.
 */
export async function createUser(request: CreateUserRequest): Promise<CreatedUser> {
  /**
   * Parsed with the shared request schema before it goes anywhere — the same
   * one the route parses, so the browser and the server cannot disagree about
   * what a username is or how long a password must be. Being strict, it also
   * refuses to put a server-owned field on the wire: no id, no hash, no active
   * flag, and above all no capability list.
   *
   * It normalizes as well as checks, so the account is created under the name
   * the person will sign in with, and the password is passed through untouched.
   */
  const body = createUserRequestSchema.parse(request);

  const response = await api.postWithoutOperationId<unknown>('/api/identity/users', body);

  /**
   * And parsed on the way back rather than asserted with a type parameter. The
   * reply is what the screen confirms an account by, so a server that answered
   * something unexpected should fail loudly here instead of rendering a
   * confident blank. The schema carries no password and no session, so nothing
   * this returns could be mistaken for a credential.
   */
  return createUserResponseSchema.parse(response).user;
}
