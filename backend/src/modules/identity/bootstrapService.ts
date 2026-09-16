import { displayNameSchema, usernameSchema, type Capability, type Role } from '@ekon/shared';
import type { z } from 'zod';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import { hashPassword } from './domain/password.js';
import {
  activeUserWithRoleExists,
  findRoleCapabilities,
  insertUser,
  isUniqueViolation,
  lockUsersForBootstrap,
  usernameExists,
  usersTableIsEmpty,
  USER_USERNAME_UNIQUE_CONSTRAINT,
} from './infrastructure/identityRepository.js';

/**
 * Creating the first owner, and nothing else.
 *
 * A brand-new installation has no users, so there is nobody who could be
 * authorized to create one — the bootstrap problem every identity system has.
 * This is the answer to it: a single operator-run command, executed once
 * against the database, that creates exactly one active OWNER.
 *
 * It is not a user-management service and must not grow into one. There is no
 * force flag, no second owner, no promotion, no password change, and no
 * deactivation here. Once an owner exists they hold `identity.manage`, and
 * every account after the first is created through the ordinary authenticated
 * workflow that arrives with it. A provisioning command that can also create
 * the tenth user is a permanent unauthenticated path into the identity tables.
 *
 * There are two ways in, and they differ in exactly one rule.
 *
 * `createInitialOwner` is the operator command, run with a shell on the
 * machine: it refuses when an active **owner** exists, which lets somebody who
 * already has a database recover from having no owner left.
 *
 * `setUpFirstOwner` is the public route the first-run screen posts to, and it
 * refuses unless the users table is **empty**. That is the stricter rule and it
 * has to be, because nobody is authenticated when it runs: an installation that
 * already holds people is one where the answer to "who may create an account"
 * is "somebody signed in", and this route must stop existing the moment the
 * first row appears.
 */

const OWNER_ROLE: Role = 'OWNER';

export interface CreateInitialOwnerInput {
  /** As typed. Normalized here — trimmed and lower-cased — before storage. */
  username: string;
  displayName: string;
  /** Plaintext. Hashed here, never stored, logged, or returned. */
  password: string;
}

/**
 * What the command may report. Deliberately carries no password hash: nothing
 * downstream of creation has a reason to see one, and a value that is never
 * returned is a value that cannot be printed by accident.
 */
export interface InitialOwnerCreated {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt: Date;
  /**
   * What this owner may do, read from `role_capabilities` inside the creating
   * transaction — never assembled from a constant in application code, which
   * would be a second authorization model that could disagree with the table
   * every request is actually resolved against.
   *
   * Sorted and free of duplicates, because the wire shape requires it (see
   * `authenticatedUserSchema`) and the query orders by capability.
   */
  capabilities: Capability[];
}

export interface BootstrapServiceDeps {
  pool: DatabasePool;
  clock: Clock;
  /** Overridable so tests can pin the generated id. */
  generateId?: (() => string) | undefined;
}

export interface IdentityBootstrapService {
  createInitialOwner(input: CreateInitialOwnerInput): Promise<InitialOwnerCreated>;
  /**
   * The same owner, created from the first-run screen instead of a shell, and
   * refused unless this installation has no users at all.
   */
  setUpFirstOwner(input: CreateInitialOwnerInput): Promise<InitialOwnerCreated>;
  /**
   * True when nobody has been created yet — what `GET /api/auth/me` answers
   * with `{ state: 'setup' }`.
   */
  needsSetup(): Promise<boolean>;
}

/**
 * Runs one shared schema and returns its normalized output, turning a failure
 * into the same structured `VALIDATION_FAILED` the HTTP layer produces. The
 * shared schema is the single definition of what a username is; this only
 * decides what a rejection looks like.
 */
function parseField(
  schema: z.ZodType<string, z.ZodTypeDef, string>,
  path: string,
  value: string,
): string {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError(
    'VALIDATION_FAILED',
    `Invalid ${path}`,
    parsed.error.issues.map((issue) => ({ path, message: issue.message })),
  );
}

export function createIdentityBootstrapService(
  deps: BootstrapServiceDeps,
): IdentityBootstrapService {
  const { pool, clock } = deps;
  const generateId = deps.generateId ?? newId;

  /**
   * One creation path, parameterized by the single thing the two callers
   * disagree about: what already existing means.
   *
   * Everything else — the validation, the hash outside the transaction, the
   * table lock, the re-check *under* the lock, the unique-violation mapping —
   * is identical and must stay identical. Two copies of this would be two
   * chances to get the lock ordering wrong, and the one that was wrong would
   * be the one nobody ran until an installation was being set up.
   */
  async function createOwner(
    input: CreateInitialOwnerInput,
    guard: (tx: DatabaseClient) => Promise<void>,
  ): Promise<InitialOwnerCreated> {
    // Validate and normalize everything before touching the database, so a
    // typo costs nothing and leaves nothing behind.
    const username = parseField(usernameSchema, 'username', input.username);
    const displayName = parseField(displayNameSchema, 'displayName', input.displayName);

    // Hashing is deliberately outside the transaction: Argon2id is slow by
    // design, and holding a table lock for the length of it would be holding
    // it for the one part of this command that touches no rows.
    const passwordHash = await hashPassword(input.password);

    const now = clock.now();
    const id = generateId();

    return withTransaction(pool, async (tx) => {
      // The lock is the whole mechanism. "Refuse if one exists" is a check
      // followed by an insert, and two callers arriving together — two browser
      // tabs on the first-run screen, a tab and the operator command — would
      // both look, both see nothing, and both write. `SHARE ROW EXCLUSIVE`
      // serializes writers to `users` for the rest of this transaction and
      // leaves every reader alone.
      await lockUsersForBootstrap(tx);

      await guard(tx);

      if (await usernameExists(tx, username)) {
        throw new AppError('CONFLICT', `Username "${username}" is already taken.`);
      }

      try {
        await insertUser(tx, {
          id,
          username,
          displayName,
          passwordHash,
          role: OWNER_ROLE,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        // The check above is not the guarantee — this is. Under the lock the
        // two agree, but a unique violation is still mapped rather than
        // surfacing as an unexplained database error.
        if (isUniqueViolation(error, USER_USERNAME_UNIQUE_CONSTRAINT)) {
          throw new AppError('CONFLICT', `Username "${username}" is already taken.`);
        }
        throw error;
      }

      return {
        id,
        username,
        displayName,
        role: OWNER_ROLE,
        createdAt: now,
        capabilities: await findRoleCapabilities(tx, OWNER_ROLE),
      };
    });
  }

  return {
    createInitialOwner: (input) =>
      createOwner(input, async (tx) => {
        if (await activeUserWithRoleExists(tx, OWNER_ROLE)) {
          throw new AppError(
            'CONFLICT',
            'An active OWNER already exists. This command creates the first owner only; ' +
              'create further accounts through the signed-in identity workflow.',
          );
        }
      }),

    setUpFirstOwner: (input) =>
      createOwner(input, async (tx) => {
        if (!(await usersTableIsEmpty(tx))) {
          throw new AppError(
            'SETUP_COMPLETE',
            'This installation has already been set up. Sign in, or ask whoever holds the ' +
              'owner account to create one for you.',
          );
        }
      }),

    // Outside any transaction and deliberately not locking: it is a question a
    // stranger asks on every page load, the answer changes exactly once in the
    // life of an installation, and the route that acts on it re-asks under the
    // lock. A `true` that has just become stale costs one refused setup, not a
    // second owner.
    needsSetup: () => usersTableIsEmpty(pool),
  };
}
