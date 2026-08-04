import { describe, expect, it } from 'vitest';
import {
  assertPasswordAcceptable,
  hashPassword,
  verifyPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../src/modules/identity/domain/password.js';

/**
 * The password utility. What matters here is not the encoding — that is the
 * library's job — but the four properties the business depends on: a stored
 * credential is never the password, the right password is accepted, a wrong one
 * is not, and two people who happen to choose the same password do not end up
 * with the same row.
 *
 * Assertions deliberately stop at the Argon2id identifier. Pinning the full
 * encoded string would make a parameter upgrade look like a test failure.
 */

const PASSWORD = 'correct horse battery staple';

describe('hashPassword', () => {
  it('never returns the password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).not.toBe(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(hash.toLowerCase()).not.toContain('horse');
  });

  it('returns an Argon2id PHC string', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    // Migration 0007 bounds the column at 512 characters.
    expect(hash.length).toBeLessThanOrEqual(512);
  });

  it('produces a different hash every time, because the salt is per call', async () => {
    // Two employees with the same password must not be recognisable as such
    // from the table, and a stolen hash must not be reusable against another
    // row.
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, PASSWORD)).toBe(true);
    expect(await verifyPassword(second, PASSWORD)).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    expect(await verifyPassword(await hashPassword(PASSWORD), PASSWORD)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(hash, 'incorrect horse battery staple')).toBe(false);
    expect(await verifyPassword(hash, `${PASSWORD} `)).toBe(false);
    expect(await verifyPassword(hash, PASSWORD.toUpperCase())).toBe(false);
  });

  it('does not trim: a space the person chose is part of the password', async () => {
    const padded = '  spaced out  ';
    const hash = await hashPassword(padded);
    expect(await verifyPassword(hash, padded)).toBe(true);
    expect(await verifyPassword(hash, padded.trim())).toBe(false);
  });

  it('fails closed on a stored value that is not an Argon2 hash', async () => {
    // A truncated or corrupted row must never be talked into granting access,
    // and must not raise either — a damaged credential is a false, not a 500.
    for (const damaged of ['', 'not-a-hash', PASSWORD, '$argon2id$v=19$broken']) {
      expect(await verifyPassword(damaged, PASSWORD), damaged).toBe(false);
    }
  });
});

describe('password rules', () => {
  it('accepts a password at the minimum length', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(PASSWORD_MIN_LENGTH))).not.toThrow();
  });

  it('rejects a password below the minimum length', async () => {
    const short = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);
    expect(() => assertPasswordAcceptable(short)).toThrow(/too short/i);
    // The rule is applied by the one function that produces a stored
    // credential, not only by its callers.
    await expect(hashPassword(short)).rejects.toThrow(/too short/i);
  });

  it('rejects an empty password', () => {
    expect(() => assertPasswordAcceptable('')).toThrow(/too short/i);
  });

  it('accepts a password at the maximum length and rejects one above it', async () => {
    expect(() => assertPasswordAcceptable('a'.repeat(PASSWORD_MAX_LENGTH))).not.toThrow();
    expect(() => assertPasswordAcceptable('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toThrow(
      /too long/i,
    );
    await expect(hashPassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).rejects.toThrow(/too long/i);
  });

  it('imposes no composition requirements', () => {
    // No required digit, symbol, or mixed case. They add very little and
    // reliably produce `Password1!`.
    for (const password of ['aaaaaaaaaa', 'chwal cheval kal 12', 'kite m antre non']) {
      expect(() => assertPasswordAcceptable(password), password).not.toThrow();
    }
  });

  it('accepts spaces as ordinary characters', () => {
    expect(() => assertPasswordAcceptable('a b c d e')).toThrow(/too short/i); // 9 characters
    expect(() => assertPasswordAcceptable('a b c d e ')).not.toThrow(); // 10
  });

  it('never puts the password in the error it raises', () => {
    // An error message travels into logs and, one day, onto a screen.
    const secret = 'shrt';
    try {
      assertPasswordAcceptable(secret);
      expect.unreachable('expected a validation error');
    } catch (error) {
      const rendered = JSON.stringify({
        message: (error as Error).message,
        details: (error as { details?: unknown }).details,
      });
      expect(rendered).not.toContain(secret);
    }
  });
});
