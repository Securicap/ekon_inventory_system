import { describe, expect, it } from 'vitest';
import {
  authenticatedUserResponseSchema,
  authenticatedUserSchema,
  loginRequestSchema,
  PASSWORD_INPUT_MAX_LENGTH,
  PASSWORD_INPUT_MIN_LENGTH,
} from '../src/index.js';

/**
 * The authentication contract. Both sides of the wire parse these shapes, so a
 * change here is a change the browser and the server have to agree on.
 *
 * What is asserted most carefully is what must *not* be in them: a login
 * request that carries anything beyond a username and a password is refused,
 * and a user response has no room for a password hash, a session id, or an
 * expiry.
 */

const PASSWORD = 'correct horse battery staple';

const USER = {
  id: '0198f0e1-2c3d-7e4f-8a9b-0c1d2e3f4a5b',
  username: 'marie.j',
  displayName: 'Marie Joseph',
  role: 'OWNER',
  capabilities: ['catalog.read', 'inventory.read'],
};

describe('loginRequestSchema', () => {
  it('accepts a username and a password', () => {
    const parsed = loginRequestSchema.parse({ username: 'marie.j', password: PASSWORD });
    expect(parsed).toEqual({ username: 'marie.j', password: PASSWORD });
  });

  it('normalizes the username, so one account has one login', () => {
    // Somebody typing their name with the shift key held, or a phone keyboard
    // capitalizing it for them, signs in to the same account.
    const parsed = loginRequestSchema.parse({ username: '  Marie.J  ', password: PASSWORD });
    expect(parsed.username).toBe('marie.j');
  });

  it('never trims the password', () => {
    // A leading or trailing space is a character the person chose. Trimming it
    // would mean the password that was set is not the password that works.
    const padded = `  ${PASSWORD}  `;
    expect(loginRequestSchema.parse({ username: 'marie.j', password: padded }).password).toBe(
      padded,
    );
  });

  it('rejects a request carrying anything else', () => {
    // Not ignored — rejected. A stray `role` or `userId` on the login route is
    // more likely an attempt than a typo, and dropping it silently would make
    // the two indistinguishable.
    for (const extra of [{ role: 'OWNER' }, { userId: 'x' }, { capabilities: [] }, { maxAge: 1 }]) {
      const result = loginRequestSchema.safeParse({
        username: 'marie.j',
        password: PASSWORD,
        ...extra,
      });
      expect(result.success, `accepted extra field ${Object.keys(extra).join()}`).toBe(false);
    }
  });

  it('requires both fields', () => {
    expect(loginRequestSchema.safeParse({ username: 'marie.j' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ password: PASSWORD }).success).toBe(false);
    expect(loginRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a username that could not belong to any account', () => {
    for (const username of ['', 'ab', 'marie j', 'marie@example.com', 'a'.repeat(41)]) {
      expect(
        loginRequestSchema.safeParse({ username, password: PASSWORD }).success,
        `accepted ${JSON.stringify(username)}`,
      ).toBe(false);
    }
  });

  it('applies the password length bounds', () => {
    const short = 'a'.repeat(PASSWORD_INPUT_MIN_LENGTH - 1);
    const long = 'a'.repeat(PASSWORD_INPUT_MAX_LENGTH + 1);
    expect(loginRequestSchema.safeParse({ username: 'marie.j', password: short }).success).toBe(
      false,
    );
    expect(loginRequestSchema.safeParse({ username: 'marie.j', password: long }).success).toBe(
      false,
    );
    expect(
      loginRequestSchema.safeParse({
        username: 'marie.j',
        password: 'a'.repeat(PASSWORD_INPUT_MAX_LENGTH),
      }).success,
    ).toBe(true);
  });

  it('bounds the password so no hash is asked to chew through pasted text', () => {
    expect(PASSWORD_INPUT_MIN_LENGTH).toBe(10);
    expect(PASSWORD_INPUT_MAX_LENGTH).toBe(128);
  });
});

describe('authenticatedUserSchema', () => {
  it('accepts the safe user shape', () => {
    expect(authenticatedUserSchema.parse(USER)).toEqual(USER);
  });

  it('has no room for a credential, a session, or an expiry', () => {
    // The strictness is the assertion. If any of these ever became a valid key,
    // something would eventually be put in it.
    for (const leak of [
      { passwordHash: '$argon2id$...' },
      { password: PASSWORD },
      { sessionId: '0198f0e1-2c3d-7e4f-8a9b-0c1d2e3f4a5b' },
      { sessionToken: 'abc' },
      { expiresAt: '2026-08-03T12:00:00.000Z' },
      { isActive: true },
    ]) {
      const result = authenticatedUserSchema.safeParse({ ...USER, ...leak });
      expect(result.success, `accepted ${Object.keys(leak).join()}`).toBe(false);
    }
  });

  it('requires a uuid id and a normalized username', () => {
    expect(authenticatedUserSchema.safeParse({ ...USER, id: 'not-a-uuid' }).success).toBe(false);
    expect(authenticatedUserSchema.safeParse({ ...USER, username: 'Marie.J' }).success).toBe(false);
  });

  it('requires a known role and known capabilities', () => {
    expect(authenticatedUserSchema.safeParse({ ...USER, role: 'ADMIN' }).success).toBe(false);
    expect(
      authenticatedUserSchema.safeParse({ ...USER, capabilities: ['inventory.destroy'] }).success,
    ).toBe(false);
  });

  it('requires capabilities to be sorted and free of duplicates', () => {
    // Two responses for the same person have to be equal as values, so a client
    // may compare or cache them without normalizing an order first.
    expect(
      authenticatedUserSchema.safeParse({
        ...USER,
        capabilities: ['inventory.read', 'catalog.read'],
      }).success,
    ).toBe(false);
    expect(
      authenticatedUserSchema.safeParse({
        ...USER,
        capabilities: ['catalog.read', 'catalog.read'],
      }).success,
    ).toBe(false);
    expect(authenticatedUserSchema.safeParse({ ...USER, capabilities: [] }).success).toBe(true);
  });
});

describe('authenticatedUserResponseSchema', () => {
  it('wraps the user, so a later addition sits beside it', () => {
    expect(authenticatedUserResponseSchema.parse({ user: USER })).toEqual({ user: USER });
  });

  it('rejects a bare user and any sibling key', () => {
    expect(authenticatedUserResponseSchema.safeParse(USER).success).toBe(false);
    expect(
      authenticatedUserResponseSchema.safeParse({ user: USER, sessionToken: 'abc' }).success,
    ).toBe(false);
  });
});
