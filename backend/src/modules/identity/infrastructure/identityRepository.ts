import type { Capability, Role } from '@ekon/shared';
import { AppError } from '../../../platform/http/errors.js';
import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';

/**
 * Identity persistence. Hand-written SQL, row shapes kept internal to the
 * module, and no other module reaches these tables — `users`, `sessions`, and
 * `role_capabilities` are identity's alone.
 *
 * Only what the initial-owner bootstrap and the authentication routes need
 * exists here. There is still no generic user repository, no list, no update,
 * no delete, and no way to read a password hash except on the login path: user
 * management arrives in a later PR and will add exactly the queries it uses.
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

/** The unique constraint two identical session token hashes would collide on. */
export const SESSION_TOKEN_HASH_UNIQUE_CONSTRAINT = 'sessions_token_hash_unique';

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

// Authentication -------------------------------------------------------------

/**
 * The user as the login path needs to see them, and nothing more.
 *
 * This is the only shape in the system that carries a password hash out of the
 * database, which is why it is this narrow: no timestamps, no columns the login
 * decision does not turn on. A wider "get user" that happened to include the
 * hash would end up being called from somewhere that then returns it.
 */
export interface LoginUser {
  id: string;
  username: string;
  displayName: string;
  /** An Argon2id PHC string. Verified in the identity module, never returned. */
  passwordHash: string;
  role: Role;
  isActive: boolean;
}

interface LoginUserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  is_active: boolean;
}

/**
 * Loads the user with this exact normalized username, active or not.
 *
 * Inactive users are returned rather than filtered out, deliberately. The
 * decision to refuse them belongs to the service, which refuses them *after*
 * verifying the password so that a deactivated account costs the same as a
 * live one and answers with the same message. A `WHERE is_active` here would
 * make "this account exists but is switched off" measurable.
 */
export async function findLoginUser(db: Queryable, username: string): Promise<LoginUser | null> {
  const { rows } = await db.query<LoginUserRow>(
    `SELECT id, username, display_name, password_hash, role, is_active
       FROM users
      WHERE username = $1`,
    [username],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    isActive: row.is_active,
  };
}

export interface InsertSessionParams {
  /** Application-generated UUIDv7, and never the cookie token. */
  id: string;
  userId: string;
  /** The SHA-256 digest. The raw token never reaches this layer. */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Creates a session, but only while the user is still active.
 *
 * Written as an INSERT ... SELECT rather than a check followed by an insert
 * because the two are separated by an Argon2id verification that takes long
 * enough for an owner to deactivate somebody in between. Conditioning the
 * insert on the row itself closes that window without a transaction, a lock, or
 * a stricter isolation level: either the user is active at the instant the row
 * is written, or no row is written.
 *
 * Returns false when nothing was inserted — the user was deactivated (or, for
 * an unknown id, never existed). That is not an error here; the caller decides
 * what to tell the person, and tells them the same thing it tells anyone whose
 * credentials did not work.
 *
 * A false is *not* the last defence. Even a session created a millisecond
 * before a deactivation is refused on the very next request, because activity
 * is re-read every time a token is resolved.
 */
export async function insertSessionForActiveUser(
  db: Queryable,
  params: InsertSessionParams,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
     SELECT $1, u.id, $3, $4, $5
       FROM users u
      WHERE u.id = $2 AND u.is_active`,
    [params.id, params.userId, params.tokenHash, params.createdAt, params.expiresAt],
  );

  if (result.rowCount === 0) return false;
  if (result.rowCount === 1) return true;

  // Unreachable: `id` is a primary key, so the SELECT yields at most one row.
  // Asserted rather than assumed, because a session is a credential and this is
  // the statement that mints one.
  throw new AppError(
    'INTERNAL',
    `Expected to insert exactly one session, inserted ${result.rowCount ?? 'unknown'}`,
  );
}

/**
 * Who a session token belongs to, resolved fresh.
 *
 * The role and the capabilities come from the `users` and `role_capabilities`
 * rows as they are *now*, never from the session — the session row holds no
 * snapshot of either, so a promotion, a demotion, or a change to what a role
 * may do takes effect on the next request without anyone signing out.
 */
export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  /** Sorted, and unique: the same session resolves to the same value twice. */
  capabilities: Capability[];
}

interface SessionPrincipalRow {
  session_id: string;
  user_id: string;
  username: string;
  display_name: string;
  role: Role;
  capabilities: Capability[];
}

/**
 * Resolves a token hash to the person presenting it, or to nothing.
 *
 * All four conditions of a usable session are in the one WHERE clause — the
 * hash matches, the session is not revoked, it has not expired, and the user is
 * still active — so there is no ordering of checks in application code for a
 * later change to get wrong, and no way to answer "which of the four failed?".
 * The caller gets a principal or a null.
 *
 * `now` is supplied by the caller from the injected clock, not read as `now()`
 * inside the statement. Expiry is a question about the moment the request
 * arrived; the database clock is a second, unmockable source of time that no
 * test could control and that would drift from every other timestamp the
 * request writes.
 *
 * One statement, and a correlated subquery for the capabilities rather than a
 * join, so a user with eleven grants still comes back as one row rather than
 * eleven to be reassembled. Both of its inputs are indexed: the unique index on
 * `token_hash`, and the primary key of `role_capabilities`.
 *
 * `COLLATE "C"` sorts by byte value, which is the same order `Array.sort` would
 * produce and is the same on every database regardless of the locale it was
 * created with. Without it the order is deterministic per-installation but not
 * across them, which is the kind of difference that shows up as a test passing
 * in CI and failing on a laptop.
 */
export async function findSessionPrincipal(
  db: Queryable,
  tokenHash: string,
  now: Date,
): Promise<SessionPrincipal | null> {
  const { rows } = await db.query<SessionPrincipalRow>(
    `SELECT s.id           AS session_id,
            u.id           AS user_id,
            u.username     AS username,
            u.display_name AS display_name,
            u.role         AS role,
            COALESCE(
              (SELECT array_agg(rc.capability ORDER BY rc.capability COLLATE "C")
                 FROM role_capabilities rc
                WHERE rc.role = u.role),
              ARRAY[]::text[]
            ) AS capabilities
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > $2
        AND u.is_active`,
    [tokenHash, now],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    capabilities: row.capabilities,
  };
}

/**
 * What a role may currently do, in the same sorted order a session resolves to.
 *
 * A role with no grants returns an empty list rather than failing. Every role
 * in the vocabulary is seeded by migration 0007, so an empty result means
 * somebody removed the grants — in which case the person signs in and can do
 * nothing, which is the safe direction for that mistake to fail in.
 */
export async function findRoleCapabilities(db: Queryable, role: Role): Promise<Capability[]> {
  const { rows } = await db.query<{ capability: Capability }>(
    `SELECT capability
       FROM role_capabilities
      WHERE role = $1
      ORDER BY capability COLLATE "C"`,
    [role],
  );
  return rows.map((row) => row.capability);
}

/**
 * Revokes the session this token belongs to, if there is one and it is not
 * already revoked.
 *
 * Deliberately says nothing about what it found. Signing out succeeds for a
 * token that is missing, invented, expired, or already spent, because the
 * person's browser ends up in the same state either way and because a logout
 * that answered differently would be a way to ask whether a token is real.
 *
 * A session is never deleted here. The row is the record that a session existed
 * and when it ended; `revoked_at` is that ending, and `expires_at` stays as it
 * was. Nor does it touch the user's other sessions: signing out of the shop
 * laptop must not sign the owner out of the browser they are working in
 * elsewhere.
 */
export async function revokeSession(
  db: Queryable,
  tokenHash: string,
  revokedAt: Date,
): Promise<void> {
  await db.query(
    `UPDATE sessions
        SET revoked_at = $2
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [tokenHash, revokedAt],
  );
}
