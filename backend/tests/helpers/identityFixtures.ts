import type { Role } from '@ekon/shared';
import { hashPassword } from '../../src/modules/identity/index.js';
import type { DatabasePool } from '../../src/platform/db/pool.js';
import { newId } from '../../src/platform/ids/uuidv7.js';

/**
 * Users for tests that need somebody to sign in as.
 *
 * Written with plain SQL rather than through the bootstrap service, because
 * that service creates exactly one owner and refuses to create a second — which
 * is the right behaviour for it and the wrong shape for a fixture. The password
 * is hashed with the real `hashPassword`, so the login path under test verifies
 * an Argon2id string that was produced the way a real one would be.
 */

export interface TestUserOptions {
  username: string;
  password: string;
  displayName?: string;
  role?: Role;
  isActive?: boolean;
  now?: Date;
}

export interface TestUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  password: string;
}

export async function createTestUser(
  pool: DatabasePool,
  options: TestUserOptions,
): Promise<TestUser> {
  const {
    username,
    password,
    displayName = 'Test Person',
    role = 'OWNER',
    isActive = true,
    now = new Date('2026-08-03T09:00:00.000Z'),
  } = options;

  const id = newId();
  const passwordHash = await hashPassword(password);

  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, role, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [id, username, displayName, passwordHash, role, isActive, now],
  );

  return { id, username, displayName, role, password };
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/** Every session row, oldest first. */
export async function sessions(pool: DatabasePool): Promise<SessionRow[]> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT id, user_id, token_hash, created_at, expires_at, revoked_at
       FROM sessions
      ORDER BY created_at, id`,
  );
  return rows;
}
