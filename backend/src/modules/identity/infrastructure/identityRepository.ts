import type { Role } from '@ekon/shared';
import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';

/**
 * Identity persistence. Hand-written SQL, row shapes kept internal to the
 * module, and no other module reaches these tables — `users`, `sessions`, and
 * `role_capabilities` are identity's alone.
 *
 * Only what the initial-owner bootstrap needs exists here. There is no generic
 * user repository, no list, no update, no session write: login and user
 * management arrive in later PRs and will add exactly the queries they use.
 */

type Queryable = DatabasePool | DatabaseClient;

export interface InsertUserParams {
  id: string;
  /** Already normalized by `usernameSchema`; the database CHECK is the backstop. */
  username: string;
  displayName: string;
  /** An Argon2id PHC string. Plaintext never reaches this layer. */
  passwordHash: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The unique constraint a duplicate username collides with. */
export const USER_USERNAME_UNIQUE_CONSTRAINT = 'users_username_unique';

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when `error` is a Postgres unique violation of the named constraint.
 * Lets the caller answer an expected collision without swallowing anything
 * else.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && candidate.constraint === constraint;
}

export async function insertUser(tx: DatabaseClient, params: InsertUserParams): Promise<void> {
  await tx.query(
    `INSERT INTO users (id, username, display_name, password_hash, role, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.id,
      params.username,
      params.displayName,
      params.passwordHash,
      params.role,
      params.isActive,
      params.createdAt,
      params.updatedAt,
    ],
  );
}

/** True when a user with this exact (normalized) username already exists. */
export async function usernameExists(db: Queryable, username: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM users WHERE username = $1`, [username]);
  return rows.length > 0;
}

/** True when at least one active user holds this role. */
export async function activeUserWithRoleExists(db: Queryable, role: Role): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM users WHERE role = $1 AND is_active LIMIT 1`, [
    role,
  ]);
  return rows.length > 0;
}

/**
 * Takes a lock that serializes writers to `users` for the rest of the
 * transaction, while leaving readers alone.
 *
 * Without it, "refuse to create a second owner" is a check followed by an
 * insert, and two bootstrap commands run at the same moment would both look,
 * both see nothing, and both write. The username UNIQUE constraint would not
 * catch that — the two owners would have different names. A one-time
 * provisioning command is exactly the place where a table-level lock costs
 * nothing and closes the race outright.
 */
export async function lockUsersForBootstrap(tx: DatabaseClient): Promise<void> {
  await tx.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
}
