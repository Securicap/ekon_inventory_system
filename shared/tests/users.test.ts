import { describe, expect, it } from 'vitest';
import {
  PASSWORD_INPUT_MAX_LENGTH,
  PASSWORD_INPUT_MIN_LENGTH,
  ROLES,
  createUserRequestSchema,
  createUserResponseSchema,
  createdUserSchema,
} from '../src/index.js';

/**
 * The account-creation contract, as both sides must read it.
 *
 * Two things are asserted here rather than in a backend test, because they are
 * properties of the *shape* and not of any route: that the request carries only
 * what a caller is entitled to state, and that the reply carries no credential.
 * The backend suite proves what the server does with a valid one.
 */

const VALID = {
  username: 'marie.j',
  displayName: 'Marie Joseph',
  password: 'correct horse battery staple',
  role: 'EMPLOYEE',
} as const;

describe('create-user request', () => {
  it('accepts the four fields an account is established from', () => {
    const parsed = createUserRequestSchema.parse(VALID);
    expect(parsed).toEqual(VALID);
  });

  it('reuses the shared username rule, normalizing as it validates', () => {
    // The same schema the login route parses, so an account is created under
    // exactly the name it will sign in with.
    expect(createUserRequestSchema.parse({ ...VALID, username: '  Marie.J  ' }).username).toBe(
      'marie.j',
    );
    expect(createUserRequestSchema.safeParse({ ...VALID, username: 'marie j' }).success).toBe(
      false,
    );
    expect(createUserRequestSchema.safeParse({ ...VALID, username: 'ab' }).success).toBe(false);
  });

  it('trims the display name and refuses a blank one', () => {
    expect(createUserRequestSchema.parse({ ...VALID, displayName: '  Marie  ' }).displayName).toBe(
      'Marie',
    );
    expect(createUserRequestSchema.safeParse({ ...VALID, displayName: '   ' }).success).toBe(false);
  });

  it('applies the shared password bounds and never trims the value', () => {
    const shortest = 'a'.repeat(PASSWORD_INPUT_MIN_LENGTH);
    expect(createUserRequestSchema.safeParse({ ...VALID, password: shortest }).success).toBe(true);
    expect(
      createUserRequestSchema.safeParse({ ...VALID, password: shortest.slice(1) }).success,
    ).toBe(false);
    expect(
      createUserRequestSchema.safeParse({
        ...VALID,
        password: 'a'.repeat(PASSWORD_INPUT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);

    // A leading or trailing space is a character the person chose. Trimming it
    // would mean the password that was set is not the password that works.
    const padded = `  ${VALID.password}  `;
    expect(createUserRequestSchema.parse({ ...VALID, password: padded }).password).toBe(padded);
  });

  it('accepts every role in the closed set and nothing outside it', () => {
    for (const role of ROLES) {
      expect(createUserRequestSchema.safeParse({ ...VALID, role }).success, role).toBe(true);
    }
    for (const role of ['ADMIN', 'employee', 'Owner', '']) {
      expect(createUserRequestSchema.safeParse({ ...VALID, role }).success, role).toBe(false);
    }
  });

  it('refuses every field the server owns', () => {
    // Rejected, not ignored: a dropped field is an attempt whose author never
    // learns it failed, and `capabilities` is the one where that would matter.
    for (const field of [
      'id',
      'passwordHash',
      'isActive',
      'capabilities',
      'createdAt',
      'updatedAt',
    ]) {
      expect(
        createUserRequestSchema.safeParse({ ...VALID, [field]: 'anything' }).success,
        field,
      ).toBe(false);
    }
  });

  it('has no capability field at all', () => {
    // The strongest statement of it: not a field that is refused by value, but
    // a shape in which permissions cannot be expressed. They come from the role.
    expect(Object.keys(createUserRequestSchema.shape).sort()).toEqual([
      'displayName',
      'password',
      'role',
      'username',
    ]);
  });
});

describe('created-user reply', () => {
  const CREATED = {
    id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    username: 'marie.j',
    displayName: 'Marie Joseph',
    role: 'EMPLOYEE',
    isActive: true,
    createdAt: '2026-08-03T12:00:00.000Z',
  } as const;

  it('describes the account without any credential', () => {
    expect(createdUserSchema.parse(CREATED)).toEqual(CREATED);
    expect(Object.keys(createdUserSchema.shape)).not.toContain('password');
    expect(Object.keys(createdUserSchema.shape)).not.toContain('passwordHash');
  });

  it('carries no capability snapshot', () => {
    // Capabilities are resolved from the role on every request. Echoing them
    // here would invite a client to keep a copy that a role change never reaches.
    expect(Object.keys(createdUserSchema.shape)).not.toContain('capabilities');
    expect(createdUserSchema.safeParse({ ...CREATED, capabilities: [] }).success).toBe(false);
  });

  it('is wrapped in `user`, as the authenticated-user response is', () => {
    expect(createUserResponseSchema.parse({ user: CREATED })).toEqual({ user: CREATED });
    expect(createUserResponseSchema.safeParse(CREATED).success).toBe(false);
  });

  it('carries no session, token, or cookie', () => {
    // Creating an account is not signing in as its owner. There is nothing in
    // this shape a caller could present as the new user.
    expect(Object.keys(createUserResponseSchema.shape)).toEqual(['user']);
    for (const field of ['token', 'sessionId', 'session', 'expiresAt']) {
      expect(
        createUserResponseSchema.safeParse({ user: CREATED, [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });
});
