import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../../../src/platform/clock/index.js';
import type { DatabasePool } from '../../../src/platform/db/pool.js';
import { AppError } from '../../../src/platform/http/errors.js';
import { DUMMY_PASSWORD_HASH } from '../../../src/modules/identity/domain/password.js';
import type * as PasswordModule from '../../../src/modules/identity/domain/password.js';
import type { GeneratedSessionToken } from '../../../src/modules/identity/domain/sessionToken.js';
import {
  createIdentityAuthService,
  type IdentityAuthService,
} from '../../../src/modules/identity/authService.js';

/**
 * The parts of signing in that are decided before the database has an opinion:
 * what a failure says, what work an unknown username still costs, and how many
 * times a token collision is worth retrying.
 *
 * The database is a stub here on purpose — these are branches that a real
 * Postgres cannot be made to take on demand. Everything that depends on real
 * rows is in `tests/integration/authLogin.test.ts`.
 *
 * There are deliberately no elapsed-time assertions. Timing on a shared CI
 * runner is noise, and a test that measured it would fail for reasons that have
 * nothing to do with this code. What is asserted instead is that the expensive
 * work happens at all.
 */

const { verifySpy } = vi.hoisted(() => ({ verifySpy: vi.fn<() => Promise<boolean>>() }));

vi.mock('../../../src/modules/identity/domain/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
  return {
    ...actual,
    verifyPassword: (passwordHash: string, password: string) => verifySpy(passwordHash, password),
  };
});

const NOW = new Date('2026-08-03T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
const USER_ID = '0198f0e1-2c3d-7e4f-8a9b-0c1d2e3f4a5b';

interface StubbedQuery {
  sql: string;
  params: readonly unknown[];
}

interface Stub {
  pool: DatabasePool;
  queries: StubbedQuery[];
  /** Rows `SELECT ... FROM users WHERE username` answers with. */
  userRows: Record<string, unknown>[];
  /** Called for the INSERT; returns a rowCount or throws. */
  onInsertSession: () => number;
}

function stubPool(): Stub {
  const stub: Stub = {
    pool: undefined as unknown as DatabasePool,
    queries: [],
    userRows: [],
    onInsertSession: () => 1,
  };

  stub.pool = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      stub.queries.push({ sql, params });
      // The insert is an INSERT ... SELECT FROM users, so it has to be matched
      // before the plain user lookup.
      if (sql.includes('INSERT INTO sessions')) {
        return { rows: [], rowCount: stub.onInsertSession() };
      }
      if (sql.includes('FROM users'))
        return { rows: stub.userRows, rowCount: stub.userRows.length };
      if (sql.includes('FROM role_capabilities')) {
        return { rows: [{ capability: 'catalog.read' }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as DatabasePool;

  return stub;
}

function activeUserRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    username: 'marie.j',
    display_name: 'Marie Joseph',
    password_hash:
      '$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    role: 'OWNER',
    is_active: true,
    ...overrides,
  };
}

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'sessions_token_hash_unique',
  });
}

function serviceFor(
  stub: Stub,
  generateSessionToken?: () => GeneratedSessionToken,
): IdentityAuthService {
  return createIdentityAuthService({
    pool: stub.pool,
    clock: fixedClock(NOW),
    ...(generateSessionToken ? { generateSessionToken } : {}),
  });
}

function insertsAttempted(stub: Stub): number {
  return stub.queries.filter((q) => q.sql.includes('INSERT INTO sessions')).length;
}

beforeEach(() => {
  verifySpy.mockReset();
  verifySpy.mockResolvedValue(true);
});

describe('a login that fails', () => {
  /**
   * The three ways to fail must be one answer. Anything that distinguishes them
   * turns the login form into a way to ask which usernames exist and which of
   * those still work.
   */
  async function failureOf(service: IdentityAuthService): Promise<AppError> {
    const error = await service
      .login({ username: 'marie.j', password: PASSWORD })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }

  it('says the same thing for an unknown username, a wrong password, and a deactivated account', async () => {
    const unknown = stubPool();

    const wrongPassword = stubPool();
    wrongPassword.userRows = [activeUserRow()];

    const inactive = stubPool();
    inactive.userRows = [activeUserRow({ is_active: false })];

    verifySpy.mockResolvedValue(false);
    const unknownFailure = await failureOf(serviceFor(unknown));
    const wrongPasswordFailure = await failureOf(serviceFor(wrongPassword));

    verifySpy.mockResolvedValue(true);
    const inactiveFailure = await failureOf(serviceFor(inactive));

    for (const failure of [unknownFailure, wrongPasswordFailure, inactiveFailure]) {
      expect(failure.code).toBe('UNAUTHENTICATED');
      expect(failure.status).toBe(401);
      expect(failure.message).toBe('Invalid username or password');
      expect(failure.details).toBeUndefined();
    }
  });

  it('never says which of the three it was', async () => {
    verifySpy.mockResolvedValue(false);
    const failure = await failureOf(serviceFor(stubPool()));
    const said = failure.message.toLowerCase();
    for (const giveaway of ['not found', 'unknown', 'inactive', 'deactivated', 'exist', 'wrong']) {
      expect(said, `leaked "${giveaway}"`).not.toContain(giveaway);
    }
  });

  it('creates no session', async () => {
    verifySpy.mockResolvedValue(false);
    const unknown = stubPool();
    await failureOf(serviceFor(unknown));
    expect(insertsAttempted(unknown)).toBe(0);

    const wrongPassword = stubPool();
    wrongPassword.userRows = [activeUserRow()];
    await failureOf(serviceFor(wrongPassword));
    expect(insertsAttempted(wrongPassword)).toBe(0);

    verifySpy.mockResolvedValue(true);
    const inactive = stubPool();
    inactive.userRows = [activeUserRow({ is_active: false })];
    await failureOf(serviceFor(inactive));
    expect(insertsAttempted(inactive)).toBe(0);
  });

  it('still verifies a password when the username belongs to nobody', async () => {
    // Otherwise an unknown username returns in the time of a database lookup
    // and a real one takes however long Argon2id takes — a difference an
    // attacker can measure from the other side of the internet.
    verifySpy.mockResolvedValue(false);
    await failureOf(serviceFor(stubPool()));

    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith(DUMMY_PASSWORD_HASH, PASSWORD);
  });

  it('uses a dummy hash that is a real Argon2id string and belongs to no row', async () => {
    // A hash that Argon2 rejected on sight would be no work at all, which is
    // the entire point of having one.
    expect(DUMMY_PASSWORD_HASH.startsWith('$argon2id$')).toBe(true);
    const { verifyPassword } = await vi.importActual<typeof PasswordModule>(
      '../../../src/modules/identity/domain/password.js',
    );
    expect(await verifyPassword(DUMMY_PASSWORD_HASH, PASSWORD)).toBe(false);
  });

  it('pays for a deactivated account before refusing it', async () => {
    // Checked after the password, never before, so "is this person still
    // employed here?" is not a question the login form answers by responding
    // faster.
    const inactive = stubPool();
    inactive.userRows = [activeUserRow({ is_active: false })];
    await failureOf(serviceFor(inactive));

    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith(activeUserRow().password_hash, PASSWORD);
  });

  it('refuses a user deactivated between the password check and the insert', async () => {
    // The insert is conditioned on the user still being active, so it writes
    // nothing and reports it. Same answer as a wrong password.
    const stub = stubPool();
    stub.userRows = [activeUserRow()];
    stub.onInsertSession = () => 0;

    const failure = await failureOf(serviceFor(stub));
    expect(failure.code).toBe('UNAUTHENTICATED');
    expect(failure.message).toBe('Invalid username or password');
  });
});

describe('a session token collision', () => {
  interface CountingGenerator {
    (): GeneratedSessionToken;
    readonly calls: number;
  }

  function countingGenerator(): CountingGenerator {
    let calls = 0;
    const generate = (): GeneratedSessionToken => {
      calls += 1;
      return { rawToken: `raw-${calls}`, tokenHash: `hash-${calls}` };
    };
    Object.defineProperty(generate, 'calls', { get: () => calls });
    return generate as CountingGenerator;
  }

  it('retries with a fresh token and creates exactly one session', async () => {
    const stub = stubPool();
    stub.userRows = [activeUserRow()];
    let attempt = 0;
    stub.onInsertSession = () => {
      attempt += 1;
      if (attempt === 1) throw uniqueViolation();
      return 1;
    };

    const generate = countingGenerator();
    const result = await serviceFor(stub, generate).login({
      username: 'marie.j',
      password: PASSWORD,
    });

    expect(generate.calls).toBe(2);
    expect(insertsAttempted(stub)).toBe(2);
    expect(result.rawSessionToken).toBe('raw-2');
  });

  it('gives up after three attempts rather than looping', async () => {
    // Three independent 256-bit values do not collide. If they appear to, the
    // generator is broken, and a bounded failure is how that surfaces.
    const stub = stubPool();
    stub.userRows = [activeUserRow()];
    stub.onInsertSession = () => {
      throw uniqueViolation();
    };

    const generate = countingGenerator();
    await expect(
      serviceFor(stub, generate).login({ username: 'marie.j', password: PASSWORD }),
    ).rejects.toThrow();

    expect(generate.calls).toBe(3);
    expect(insertsAttempted(stub)).toBe(3);
  });

  it('does not retry an unrelated database failure', async () => {
    // Retrying an unknown fault is how one broken statement becomes three.
    const stub = stubPool();
    stub.userRows = [activeUserRow()];
    stub.onInsertSession = () => {
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    };

    const generate = countingGenerator();
    await expect(
      serviceFor(stub, generate).login({ username: 'marie.j', password: PASSWORD }),
    ).rejects.toThrow('deadlock detected');

    expect(generate.calls).toBe(1);
    expect(insertsAttempted(stub)).toBe(1);
  });

  it('does not retry a unique violation on another constraint', async () => {
    const stub = stubPool();
    stub.userRows = [activeUserRow()];
    stub.onInsertSession = () => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'sessions_pkey',
      });
    };

    const generate = countingGenerator();
    await expect(
      serviceFor(stub, generate).login({ username: 'marie.j', password: PASSWORD }),
    ).rejects.toThrow('duplicate key');

    expect(generate.calls).toBe(1);
  });
});

describe('resolving and ending a session', () => {
  it('answers null for a missing token without asking the database', async () => {
    const stub = stubPool();
    expect(await serviceFor(stub).authenticate(null)).toBeNull();
    expect(await serviceFor(stub).authenticate('')).toBeNull();
    expect(stub.queries).toHaveLength(0);
  });

  it('does nothing at all when logout is given no token', async () => {
    const stub = stubPool();
    await expect(serviceFor(stub).logout(null)).resolves.toBeUndefined();
    await expect(serviceFor(stub).logout('')).resolves.toBeUndefined();
    expect(stub.queries).toHaveLength(0);
  });
});
