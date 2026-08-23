import type { CreateUserRequest, CreatedUser } from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import { conflict } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import { hashPassword } from './domain/password.js';
import {
  USER_USERNAME_UNIQUE_CONSTRAINT,
  findUserDisplayNames,
  insertUser,
  isUniqueViolation,
} from './infrastructure/identityRepository.js';

/**
 * Creating an account for somebody else — the workflow the bootstrap command
 * has been pointing at since it was written.
 *
 * The bootstrap answers the question a new installation asks: there are no
 * users, so nobody can be authorized to make one. It answers it once, for one
 * `OWNER`, and deliberately cannot do anything else — a provisioning command
 * that could also create the tenth user would be a permanent unauthenticated
 * path into `users`. This service is the other side of that decision: every
 * account after the first is created by somebody who is signed in and holds
 * `identity.manage`, through a route the same enforcement hook guards as every
 * other.
 *
 * It creates an account and stops there. There is no listing, no editing, no
 * role change, no deactivation, and no password reset, and this file is not
 * where any of them should be added by accident — each is a separate authority
 * over somebody's access, and each deserves to be decided on its own.
 *
 * **It does not sign anybody in.** No session row is written, no token is
 * generated, and nothing this returns could be presented as the new user. An
 * account and a session are different things, and a workflow that produced both
 * would let one person obtain a credential for another.
 */

export interface UserServiceDeps {
  pool: DatabasePool;
  clock: Clock;
  /** Overridable so tests can pin the generated id. Production uses UUIDv7. */
  generateId?: (() => string) | undefined;
}

export interface IdentityUserService {
  /**
   * Creates one active user and returns it without its password hash.
   *
   * Takes the parsed request: the username arrives normalized and the display
   * name trimmed, because the shared schema did that at the edge. Throws
   * `CONFLICT` when the username is taken.
   */
  createUser(input: CreateUserRequest): Promise<CreatedUser>;
  /**
   * The display names of a known set of user ids, in bulk.
   *
   * The one thing another module may ask about a person, and it exists because
   * a stock movement records who posted it and a screen showing that movement
   * has to be able to say who. It is deliberately not a user lookup: no role,
   * no status, no username, no credential, nothing that could be composed into
   * an account listing this module has decided not to offer yet.
   *
   * **An id that resolves to nothing is absent from the result rather than an
   * error.** `inventory_movements.user_id` has no foreign key onto `users`
   * (INV-11) — movements predate the identity module and some carry actor uuids
   * that were never accounts. The caller keeps the permanent id and reports no
   * name; no name is invented to fill the gap.
   *
   * Deactivated users resolve normally: their name has to stay readable on
   * every movement they posted, which is why INV-16 deactivates rather than
   * deletes.
   */
  findUserDisplayNames(userIds: string[]): Promise<{ id: string; displayName: string }[]>;
}

export function createIdentityUserService(deps: UserServiceDeps): IdentityUserService {
  const { pool, clock } = deps;
  const generateId = deps.generateId ?? newId;

  return {
    findUserDisplayNames: (userIds) => findUserDisplayNames(pool, userIds),

    async createUser(input) {
      /**
       * Hashing first, and outside anything that holds a row.
       *
       * Argon2id is slow on purpose. Whatever it is made to wait for — a
       * transaction, a lock, a connection nobody else can use meanwhile — it
       * waits for at the one moment in this workflow that touches no rows at
       * all. `hashPassword` re-applies the length bounds the schema already
       * checked, because it is the only function in the system that produces a
       * stored credential and that is where "no short password was ever hashed"
       * should be true rather than customary.
       */
      const passwordHash = await hashPassword(input.password);

      const id = generateId();
      const now = clock.now();

      /**
       * One statement, no transaction, and no "is this username taken?" read
       * before it.
       *
       * A pre-check would be a second answer to a question the UNIQUE
       * constraint already answers, and it could only ever be a stale one: the
       * gap between reading and writing is exactly where the duplicate this
       * check is looking for gets created. So the insert is allowed to fail,
       * and the failure is translated. The constraint is the rule; this is how
       * it is reported.
       *
       * The bootstrap does take a lock, and for a reason that does not apply
       * here: "at most one active owner" spans rows that no constraint
       * connects. One username per person is a single-column UNIQUE.
       */
      try {
        await insertUser(pool, {
          id,
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          role: input.role,
          // The server's, not the request's. A new account is active; there is
          // no deactivation workflow yet, and a request that could create an
          // inactive user would be creating one nobody can turn on.
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (isUniqueViolation(error, USER_USERNAME_UNIQUE_CONSTRAINT)) {
          // Names the username, and nothing else. The caller holds
          // `identity.manage`, so telling them which name is taken discloses
          // nothing they could not learn by trying every name — and without it
          // they cannot act on the refusal.
          throw conflict(`Username "${input.username}" is already taken`);
        }
        throw error;
      }

      // Built from what was written, and deliberately not read back: there is
      // no second row to reconcile with, and a SELECT here would be a round
      // trip to be told what this function just decided. The password hash is
      // not in this shape at all, so it cannot travel any further.
      return {
        id,
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        isActive: true,
        createdAt: now.toISOString(),
      };
    },
  };
}
