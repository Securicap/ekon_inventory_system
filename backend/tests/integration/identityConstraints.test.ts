import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITIES, DEFAULT_ROLE_CAPABILITIES, ROLES, USERNAME_PATTERN } from '@ekon/shared';
import { hashPassword } from '../../src/modules/identity/domain/password.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * The identity invariants, tested against real PostgreSQL.
 *
 * Every rule here is enforced by the database rather than only by the code that
 * usually writes these rows. That is the point: a future service, a repair
 * script, or a hand-typed `psql` session must not be able to create a user
 * whose username is padded or whose role is a typo.
 *
 * The password column is the deliberate exception. Its constraints are
 * structural — nonblank, trimmed, bounded — and say nothing about which
 * algorithm produced the value. Argon2id is the application's rule, enforced
 * and tested in `tests/unit/identity/password.test.ts`, where it can change
 * without a migration.
 */

const NOW = new Date('2026-08-03T12:00:00.000Z');
const LATER = new Date('2026-08-03T18:00:00.000Z');

/**
 * A real hash from the application's own password utility, generated once and
 * reused. Every fixture below is therefore written the way production writes
 * one, rather than with a literal that only looks the part.
 */
let HASH: string;

let usernameCounter = 0;
function nextUsername(): string {
  usernameCounter += 1;
  return `user.${usernameCounter}`;
}

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  HASH = await hashPassword('correct horse battery staple');
});

afterAll(async () => {
  await db.drop();
});

interface UserFields {
  id?: string;
  username?: string;
  displayName?: string;
  passwordHash?: string;
  role?: string;
  isActive?: boolean;
}

async function insertUser(fields: UserFields = {}): Promise<string> {
  const id = fields.id ?? newId();
  await db.pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, role, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      id,
      fields.username ?? nextUsername(),
      fields.displayName ?? 'Marie Joseph',
      fields.passwordHash ?? HASH,
      fields.role ?? 'EMPLOYEE',
      fields.isActive ?? true,
      NOW,
    ],
  );
  return id;
}

interface SessionFields {
  id?: string;
  userId?: string;
  tokenHash?: string;
  createdAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date | null;
}

let tokenCounter = 0;
function nextTokenHash(): string {
  tokenCounter += 1;
  return tokenCounter.toString(16).padStart(64, '0');
}

async function insertSession(fields: SessionFields = {}): Promise<string> {
  const id = fields.id ?? newId();
  await db.pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      fields.userId ?? (await insertUser()),
      fields.tokenHash ?? nextTokenHash(),
      fields.createdAt ?? NOW,
      fields.expiresAt ?? LATER,
      fields.revokedAt ?? null,
    ],
  );
  return id;
}

describe('users', () => {
  it('accepts a well-formed user', async () => {
    const id = await insertUser({ username: 'marie.j', role: 'OWNER' });
    const { rows } = await db.pool.query<{
      username: string;
      display_name: string;
      role: string;
      is_active: boolean;
    }>(`SELECT username, display_name, role, is_active FROM users WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({
      username: 'marie.j',
      display_name: 'Marie Joseph',
      role: 'OWNER',
      is_active: true,
    });
  });

  it('accepts every character the username rule permits', async () => {
    for (const username of ['jean-luc', 'j.smith', 'user_1', 'abc', 'a-b_c.9', 'a'.repeat(40)]) {
      await expect(insertUser({ username }), username).resolves.toBeTruthy();
    }
  });

  it('rejects a duplicate username', async () => {
    await insertUser({ username: 'duplicate.me' });
    await expect(insertUser({ username: 'duplicate.me' })).rejects.toMatchObject({
      constraint: 'users_username_unique',
    });
  });

  it('rejects an upper-cased username', async () => {
    // Storing one canonical form is what makes a duplicate an ordinary UNIQUE
    // violation rather than a case-folding question at every comparison.
    await expect(insertUser({ username: 'Marie' })).rejects.toMatchObject({
      constraint: 'users_username_format',
    });
  });

  it('rejects a padded username', async () => {
    for (const username of [' marie', 'marie ', ' marie ']) {
      await expect(insertUser({ username }), username).rejects.toMatchObject({
        constraint: 'users_username_format',
      });
    }
  });

  it('rejects characters outside the safe set', async () => {
    for (const username of ['marie j', 'marie@shop', 'marie!', 'marié', 'marie/j', 'marie+1']) {
      await expect(insertUser({ username }), username).rejects.toMatchObject({
        constraint: 'users_username_format',
      });
    }
  });

  it('rejects a username that is too short or too long', async () => {
    for (const username of ['', 'ab', 'a'.repeat(41)]) {
      await expect(insertUser({ username }), `"${username}"`).rejects.toMatchObject({
        constraint: 'users_username_format',
      });
    }
  });

  it('enforces the same username rule the shared schema does', async () => {
    // One pattern, two enforcement points. If either side is edited without the
    // other, this fails.
    const { rows } = await db.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'users_username_format'`,
    );
    expect(rows[0]?.definition).toContain(USERNAME_PATTERN.source);
  });

  it('rejects a blank, padded, or over-long display name', async () => {
    await expect(insertUser({ displayName: '' })).rejects.toMatchObject({
      constraint: 'users_display_name_not_blank',
    });
    await expect(insertUser({ displayName: '   ' })).rejects.toMatchObject({
      constraint: 'users_display_name_trimmed',
    });
    await expect(insertUser({ displayName: ' Marie ' })).rejects.toMatchObject({
      constraint: 'users_display_name_trimmed',
    });
    await expect(insertUser({ displayName: 'a'.repeat(121) })).rejects.toMatchObject({
      constraint: 'users_display_name_max_len',
    });
    await expect(insertUser({ displayName: 'a'.repeat(120) })).resolves.toBeTruthy();
  });

  it('accepts an accented display name', async () => {
    // Employees are named in Haitian Creole and French.
    await expect(insertUser({ displayName: 'Wélgentz Étienne' })).resolves.toBeTruthy();
  });

  it('accepts a hash the application actually produced', async () => {
    // HASH comes from `hashPassword`, so this is the real encoded Argon2id
    // string the bootstrap and the future login path will store — length,
    // punctuation, base64 padding and all.
    expect(HASH.startsWith('$argon2id$')).toBe(true);
    const id = await insertUser({ passwordHash: HASH });
    const { rows } = await db.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.password_hash).toBe(HASH);
  });

  it('rejects a blank password hash', async () => {
    await expect(insertUser({ passwordHash: '' })).rejects.toMatchObject({
      constraint: 'users_password_hash_not_blank',
    });
  });

  it('rejects a whitespace-padded password hash', async () => {
    // `btrim` with no second argument strips spaces, which is the same
    // definition of "trimmed" every other text column in this schema uses. An
    // Argon2 PHC string contains no whitespace at all, so a padded value means
    // something concatenated or copy-pasted it.
    for (const value of [`${HASH} `, ` ${HASH}`, `  ${HASH}  `]) {
      await expect(
        insertUser({ passwordHash: value }),
        JSON.stringify(value),
      ).rejects.toMatchObject({ constraint: 'users_password_hash_trimmed' });
    }
  });

  it('rejects an over-long password hash', async () => {
    await expect(insertUser({ passwordHash: 'a'.repeat(513) })).rejects.toMatchObject({
      constraint: 'users_password_hash_max_len',
    });
    await expect(insertUser({ passwordHash: 'a'.repeat(512) })).resolves.toBeTruthy();
  });

  it('leaves the choice of hashing algorithm to the application', async () => {
    // Structural constraints only. The database does not recognize Argon2 and
    // must not: a CHECK on the encoding would have to be migrated in lockstep
    // with any algorithm change, and would forbid the interim state where old
    // and new hashes coexist while accounts rehash on login.
    //
    // That Argon2id is what gets written is the application's guarantee,
    // enforced in `domain/password.ts` and asserted in its unit tests.
    await expect(
      insertUser({ passwordHash: '$2b$12$abcdefghijklmnopqrstuv' }),
    ).resolves.toBeTruthy();

    const { rows } = await db.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'users'::regclass AND contype = 'c'`,
    );
    const definitions = rows.map((r) => r.definition).join('\n');
    expect(definitions).not.toMatch(/argon/i);
  });

  it('accepts every role in the shared vocabulary and nothing else', async () => {
    for (const role of ROLES) {
      await expect(insertUser({ role }), role).resolves.toBeTruthy();
    }
    for (const role of ['ADMIN', 'owner', 'SUPERADMIN', 'CLERK', '']) {
      await expect(insertUser({ role }), `"${role}"`).rejects.toMatchObject({
        constraint: 'users_role_known',
      });
    }
  });

  it('defaults a user to active and allows an inactive one', async () => {
    const id = newId();
    await db.pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, 'Default Active', $3, 'EMPLOYEE', $4, $4)`,
      [id, nextUsername(), HASH, NOW],
    );
    const { rows } = await db.pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM users WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.is_active).toBe(true);

    // Someone who has left is deactivated, never deleted: their name has to
    // stay readable on every movement they posted.
    const inactiveId = await insertUser({ isActive: false });
    const { rows: inactive } = await db.pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM users WHERE id = $1`,
      [inactiveId],
    );
    expect(inactive[0]?.is_active).toBe(false);
  });

  it('refuses to delete a user that a session points at', async () => {
    const userId = await insertUser();
    await insertSession({ userId });
    await expect(db.pool.query(`DELETE FROM users WHERE id = $1`, [userId])).rejects.toMatchObject({
      code: '23503', // foreign_key_violation
    });
  });
});

describe('sessions', () => {
  it('accepts a well-formed session', async () => {
    const id = await insertSession();
    const { rows } = await db.pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM sessions WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it('rejects a duplicate token hash', async () => {
    const tokenHash = nextTokenHash();
    await insertSession({ tokenHash });
    await expect(insertSession({ tokenHash })).rejects.toMatchObject({
      constraint: 'sessions_token_hash_unique',
    });
  });

  it('rejects a blank, padded, or over-long token hash', async () => {
    await expect(insertSession({ tokenHash: '' })).rejects.toMatchObject({
      constraint: 'sessions_token_hash_not_blank',
    });
    await expect(insertSession({ tokenHash: ` ${nextTokenHash()}` })).rejects.toMatchObject({
      constraint: 'sessions_token_hash_trimmed',
    });
    await expect(insertSession({ tokenHash: 'a'.repeat(129) })).rejects.toMatchObject({
      constraint: 'sessions_token_hash_max_len',
    });
  });

  it('rejects a session for a user that does not exist', async () => {
    await expect(insertSession({ userId: newId() })).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects an expiry at or before creation', async () => {
    for (const expiresAt of [NOW, new Date(NOW.getTime() - 1000)]) {
      await expect(insertSession({ expiresAt }), expiresAt.toISOString()).rejects.toMatchObject({
        constraint: 'sessions_expires_after_created',
      });
    }
  });

  it('rejects a revocation before creation', async () => {
    await expect(insertSession({ revokedAt: new Date(NOW.getTime() - 1) })).rejects.toMatchObject({
      constraint: 'sessions_revoked_not_before_created',
    });
  });

  it('keeps an expired session representable', async () => {
    // Expiry is evaluated by application code against the injected clock, so a
    // session whose window has passed is an ordinary readable row. A CHECK
    // against the database clock would make history unwritable and then
    // retroactively invalid.
    const past = new Date('2020-01-01T00:00:00.000Z');
    const id = await insertSession({
      createdAt: past,
      expiresAt: new Date(past.getTime() + 3600_000),
    });
    const { rows } = await db.pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM sessions WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.expires_at.toISOString()).toBe('2020-01-01T01:00:00.000Z');
  });

  it('keeps a revoked session representable, including one revoked at the moment it began', async () => {
    const id = await insertSession({ revokedAt: NOW });
    const { rows } = await db.pool.query<{ revoked_at: Date }>(
      `SELECT revoked_at FROM sessions WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.revoked_at.toISOString()).toBe(NOW.toISOString());

    // And revoked later, which is the ordinary case.
    const laterId = await insertSession({ revokedAt: new Date(NOW.getTime() + 60_000) });
    expect(laterId).toBeTruthy();
  });
});

describe('role capabilities', () => {
  async function seededMapping(): Promise<Record<string, string[]>> {
    const { rows } = await db.pool.query<{ role: string; capability: string }>(
      `SELECT role, capability FROM role_capabilities ORDER BY role, capability`,
    );
    const mapping: Record<string, string[]> = {};
    for (const row of rows) (mapping[row.role] ??= []).push(row.capability);
    return mapping;
  }

  it('matches DEFAULT_ROLE_CAPABILITIES exactly', async () => {
    // The seed is written out by hand in the migration and the mapping is
    // written out by hand in `@ekon/shared`, because neither may import the
    // other. This is what keeps them from drifting: it fails if either side
    // gains or loses a single grant.
    const expected: Record<string, string[]> = {};
    for (const role of ROLES) {
      expected[role] = [...(DEFAULT_ROLE_CAPABILITIES[role] ?? [])].sort();
    }
    expect(await seededMapping()).toEqual(expected);
  });

  it('grants an employee exactly the four capabilities the counter job needs', async () => {
    const { rows } = await db.pool.query<{ capability: string }>(
      `SELECT capability FROM role_capabilities WHERE role = 'EMPLOYEE' ORDER BY capability`,
    );
    expect(rows.map((r) => r.capability)).toEqual([
      'catalog.read',
      'inventory.read',
      'inventory.receive',
      'inventory.remove',
    ]);
  });

  it('withholds every privileged capability from an employee', async () => {
    const { rows } = await db.pool.query<{ capability: string }>(
      `SELECT capability FROM role_capabilities WHERE role = 'EMPLOYEE'`,
    );
    const granted = new Set(rows.map((r) => r.capability));
    for (const capability of [
      'catalog.write',
      'catalog.deactivate',
      'inventory.adjust',
      'inventory.count',
      'inventory.reverse',
      'audit.read',
      'identity.manage',
      'reports.export',
    ]) {
      expect(granted.has(capability), `employee should not hold ${capability}`).toBe(false);
    }
  });

  it('gives owners and super admins every capability, and managers all but identity.manage', async () => {
    const mapping = await seededMapping();
    for (const role of ['OWNER', 'SUPER_ADMIN']) {
      expect([...(mapping[role] ?? [])].sort()).toEqual([...CAPABILITIES].sort());
    }
    expect(mapping.MANAGER).not.toContain('identity.manage');
    expect([...(mapping.MANAGER ?? []), 'identity.manage'].sort()).toEqual(
      [...CAPABILITIES].sort(),
    );
  });

  it('rejects a duplicate grant', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO role_capabilities (role, capability) VALUES ('EMPLOYEE', 'catalog.read')`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects an unknown role', async () => {
    for (const role of ['ADMIN', 'employee', 'CLERK', ' EMPLOYEE']) {
      await expect(
        db.pool.query(`INSERT INTO role_capabilities (role, capability) VALUES ($1, $2)`, [
          role,
          'catalog.read',
        ]),
        role,
      ).rejects.toMatchObject({ constraint: 'role_capabilities_role_known' });
    }
  });

  it('rejects an unknown capability', async () => {
    for (const capability of [
      'inventory.negative',
      'catalog.delete',
      'CATALOG.READ',
      ' catalog.read',
    ]) {
      await expect(
        db.pool.query(`INSERT INTO role_capabilities (role, capability) VALUES ($1, $2)`, [
          'EMPLOYEE',
          capability,
        ]),
        capability,
      ).rejects.toMatchObject({ constraint: 'role_capabilities_capability_known' });
    }
  });

  it('accepts every capability in the shared vocabulary', async () => {
    // The CHECK constraint lists the vocabulary by hand. If a capability is
    // added to `@ekon/shared` without a migration, this fails.
    for (const capability of CAPABILITIES) {
      await expect(
        db.pool.query(`INSERT INTO role_capabilities (role, capability) VALUES ($1, $2)`, [
          'SUPER_ADMIN',
          capability,
        ]),
        capability,
      ).rejects.toMatchObject({ code: '23505' }); // already granted, not a CHECK failure
    }
  });
});
