import { displayNameSchema, usernameSchema, type Role } from '@ekon/shared';
import type { z } from 'zod';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import { hashPassword } from './domain/password.js';
import {
  activeUserWithRoleExists,
  insertUser,
  isUniqueViolation,
  lockUsersForBootstrap,
  usernameExists,
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
}

export interface BootstrapServiceDeps {
  pool: DatabasePool;
  clock: Clock;
  /** Overridable so tests can pin the generated id. */
  generateId?: (() => string) | undefined;
}

export interface IdentityBootstrapService {
  createInitialOwner(input: CreateInitialOwnerInput): Promise<InitialOwnerCreated>;
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

  return {
    async createInitialOwner(input) {
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
        await lockUsersForBootstrap(tx);

        if (await activeUserWithRoleExists(tx, OWNER_ROLE)) {
          throw new AppError(
            'CONFLICT',
            'An active OWNER already exists. This command creates the first owner only; ' +
              'create further accounts through the signed-in identity workflow.',
          );
        }

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

        return { id, username, displayName, role: OWNER_ROLE, createdAt: now };
      });
    },
  };
}
