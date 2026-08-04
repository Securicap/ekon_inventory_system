import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/platform/clock/index.js';
import { verifyPassword } from '../../src/modules/identity/domain/password.js';
import {
  createIdentityBootstrapService,
  type IdentityBootstrapService,
} from '../../src/modules/identity/index.js';
import { isUuid, newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * The initial-owner bootstrap, driven through the service the CLI calls rather
 * than by spawning the command. Same code, no shell, no dependency on whichever
 * environment variables the developer happens to have exported.
 *
 * The refusals matter more than the happy path. This command runs once, by
 * hand, against a real database, usually by someone who has not read the code —
 * so every way it can be misused has to fail clearly and leave nothing behind.
 */

const NOW = new Date('2026-08-03T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple';

let db: TestDatabase;
let service: IdentityBootstrapService;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

async function users(): Promise<UserRow[]> {
  const { rows } = await db.pool.query<UserRow>(`SELECT * FROM users ORDER BY username`);
  return rows;
}

beforeAll(async () => {
  db = await createTestDatabase();
  service = createIdentityBootstrapService({ pool: db.pool, clock: fixedClock(NOW) });
});

afterEach(async () => {
  await db.pool.query(`DELETE FROM users`);
});

afterAll(async () => {
  await db.drop();
});

describe('creating the first owner', () => {
  it('creates one active OWNER', async () => {
    const created = await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });

    expect(created).toMatchObject({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      role: 'OWNER',
      createdAt: NOW,
    });
    expect(isUuid(created.id)).toBe(true);

    const rows = await users();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      username: 'marie.j',
      display_name: 'Marie Joseph',
      role: 'OWNER',
      is_active: true,
    });
  });

  it('stamps both timestamps from the injected clock', async () => {
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });
    const [row] = await users();
    expect(row?.created_at.toISOString()).toBe(NOW.toISOString());
    expect(row?.updated_at.toISOString()).toBe(NOW.toISOString());
  });

  it('uses the application-generated id it was given', async () => {
    const id = newId();
    const scoped = createIdentityBootstrapService({
      pool: db.pool,
      clock: fixedClock(NOW),
      generateId: () => id,
    });
    const created = await scoped.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });
    expect(created.id).toBe(id);
  });

  it('normalizes the username, trimming and lower-casing it', async () => {
    const created = await service.createInitialOwner({
      username: '  Marie.J  ',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });
    expect(created.username).toBe('marie.j');
    expect((await users())[0]?.username).toBe('marie.j');
  });

  it('trims the display name and preserves its case', async () => {
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: '  Wélgentz Étienne  ',
      password: PASSWORD,
    });
    expect((await users())[0]?.display_name).toBe('Wélgentz Étienne');
  });

  it('stores the password as an Argon2id hash that verifies', async () => {
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });
    const hash = (await users())[0]?.password_hash ?? '';

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, 'not the password')).toBe(false);
  });

  it('persists the password nowhere, in no form', async () => {
    // The whole row, serialized. If the plaintext appears in any column — a
    // display name built from it, a hint, a stray copy — this fails.
    const password = 'zoranj-kannel-lapli-solèy';
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password,
    });
    const serialized = JSON.stringify(await users());
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain('zoranj');
  });

  it('keeps a password with spaces exactly as given', async () => {
    const padded = '  spaced out passphrase  ';
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: padded,
    });
    const hash = (await users())[0]?.password_hash ?? '';
    expect(await verifyPassword(hash, padded)).toBe(true);
    expect(await verifyPassword(hash, padded.trim())).toBe(false);
  });
});

describe('refusals', () => {
  async function expectRefused(
    input: { username: string; displayName: string; password: string },
    code: string,
    message: RegExp,
  ): Promise<void> {
    await expect(service.createInitialOwner(input)).rejects.toMatchObject({ code });
    await expect(service.createInitialOwner(input)).rejects.toThrow(message);
  }

  it('refuses a second bootstrap while an active owner exists', async () => {
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });

    // A different username, so this is the owner rule and not the unique
    // constraint doing the work.
    await expectRefused(
      { username: 'jean.b', displayName: 'Jean Baptiste', password: PASSWORD },
      'CONFLICT',
      /active OWNER already exists/i,
    );

    expect(await users()).toHaveLength(1);
  });

  it('refuses a duplicate username once the first owner is deactivated', async () => {
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });
    await db.pool.query(`UPDATE users SET is_active = false`);

    await expectRefused(
      { username: '  MARIE.J ', displayName: 'Marie Joseph', password: PASSWORD },
      'CONFLICT',
      /already taken/i,
    );

    expect(await users()).toHaveLength(1);
  });

  it('refuses an invalid username', async () => {
    for (const username of ['ab', 'Marie!', 'marie j', '', '   ', 'a'.repeat(41)]) {
      await expect(
        service.createInitialOwner({
          username,
          displayName: 'Marie Joseph',
          password: PASSWORD,
        }),
        `"${username}"`,
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await users()).toHaveLength(0);
  });

  it('refuses a blank or over-long display name', async () => {
    for (const displayName of ['', '   ', 'a'.repeat(121)]) {
      await expect(
        service.createInitialOwner({ username: 'marie.j', displayName, password: PASSWORD }),
        `"${displayName}"`,
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await users()).toHaveLength(0);
  });

  it('refuses a password below the minimum length', async () => {
    await expectRefused(
      { username: 'marie.j', displayName: 'Marie Joseph', password: 'short' },
      'VALIDATION_FAILED',
      /too short/i,
    );
    expect(await users()).toHaveLength(0);
  });

  it('refuses a password above the maximum length', async () => {
    await expectRefused(
      { username: 'marie.j', displayName: 'Marie Joseph', password: 'a'.repeat(129) },
      'VALIDATION_FAILED',
      /too long/i,
    );
    expect(await users()).toHaveLength(0);
  });

  it('never repeats the password in the error it raises', async () => {
    const password = 'shrt';
    try {
      await service.createInitialOwner({
        username: 'marie.j',
        displayName: 'Marie Joseph',
        password,
      });
      expect.unreachable('expected a validation error');
    } catch (error) {
      const rendered = JSON.stringify({
        message: (error as Error).message,
        details: (error as { details?: unknown }).details,
      });
      expect(rendered).not.toContain(password);
    }
  });

  it('leaves no partial row behind when it refuses', async () => {
    // Every refusal above already asserts the count. This one checks the case
    // that fails *inside* the transaction, after the id and hash exist.
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });
    await expect(
      service.createInitialOwner({
        username: 'jean.b',
        displayName: 'Jean Baptiste',
        password: PASSWORD,
      }),
    ).rejects.toThrow();

    const rows = await users();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('marie.j');
  });

  it('creates an owner again once the table is empty, without any state of its own', async () => {
    // The command holds no "already bootstrapped" flag. Whether it may run is
    // answered by the table it writes to, so restoring a backup or dropping the
    // database does not leave it wedged.
    await service.createInitialOwner({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: PASSWORD,
    });
    await db.pool.query(`DELETE FROM users`);
    await expect(
      service.createInitialOwner({
        username: 'jean.b',
        displayName: 'Jean Baptiste',
        password: PASSWORD,
      }),
    ).resolves.toMatchObject({ username: 'jean.b', role: 'OWNER' });
  });
});
