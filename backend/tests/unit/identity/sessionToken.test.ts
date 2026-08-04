import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_TOKEN_BYTES,
} from '../../../src/modules/identity/domain/sessionToken.js';

/**
 * The session token. Possession of one is the credential, so the properties
 * asserted here are the ones the whole session model rests on: tokens are
 * unpredictable, what the database stores is not what the browser holds, and
 * the same token always finds the same row.
 */

const HEX_64 = /^[0-9a-f]{64}$/;
/** base64url: the alphabet a cookie value can carry unquoted and unescaped. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('generateSessionToken', () => {
  it('never generates the same token twice', () => {
    const tokens = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const { rawToken, tokenHash } = generateSessionToken();
      tokens.add(rawToken);
      hashes.add(tokenHash);
    }
    expect(tokens.size).toBe(500);
    expect(hashes.size).toBe(500);
  });

  it('does not hand out the token it stores', () => {
    // The point of the whole design: a stolen database yields nothing that can
    // be presented to the server.
    const { rawToken, tokenHash } = generateSessionToken();
    expect(tokenHash).not.toBe(rawToken);
    expect(tokenHash).not.toContain(rawToken);
    expect(rawToken).not.toContain(tokenHash);
  });

  it('returns the hash of the token it returns', () => {
    const { rawToken, tokenHash } = generateSessionToken();
    expect(tokenHash).toBe(hashSessionToken(rawToken));
  });

  it('carries 256 bits of entropy in a value a cookie can hold', () => {
    const { rawToken } = generateSessionToken();
    expect(SESSION_TOKEN_BYTES).toBe(32);
    // 32 bytes of base64url, unpadded.
    expect(rawToken).toMatch(BASE64URL);
    expect(rawToken).toHaveLength(43);
    expect(Buffer.from(rawToken, 'base64url')).toHaveLength(SESSION_TOKEN_BYTES);
    // Nothing that would need quoting, escaping, or re-encoding on the way to
    // the browser and back.
    expect(rawToken).not.toMatch(/[\s;,="\\]/);
    expect(encodeURIComponent(rawToken)).toBe(rawToken);
  });

  it('spreads its output across the whole alphabet', () => {
    // A crude smoke test for a generator wedged into returning something
    // structured. Not a randomness test — the CSPRNG is the platform's.
    const characters = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const character of generateSessionToken().rawToken) characters.add(character);
    }
    expect(characters.size).toBeGreaterThan(50);
  });
});

describe('hashSessionToken', () => {
  it('is deterministic, because it is the lookup key', () => {
    const { rawToken, tokenHash } = generateSessionToken();
    expect(hashSessionToken(rawToken)).toBe(tokenHash);
    expect(hashSessionToken(rawToken)).toBe(hashSessionToken(rawToken));
  });

  it('produces a lowercase 64-character hex digest', () => {
    // Migration 0007 bounds `sessions.token_hash` at 128 characters and
    // requires it trimmed and nonblank.
    for (const value of ['', 'a', generateSessionToken().rawToken, 'x'.repeat(10_000)]) {
      const digest = hashSessionToken(value);
      expect(digest).toMatch(HEX_64);
      expect(digest).toBe(digest.trim());
      expect(digest.length).toBeLessThanOrEqual(128);
    }
  });

  it('is sha-256', () => {
    const value = 'not-a-real-token';
    expect(hashSessionToken(value)).toBe(createHash('sha256').update(value, 'utf8').digest('hex'));
  });

  it('gives different tokens different hashes', () => {
    expect(hashSessionToken('a')).not.toBe(hashSessionToken('b'));
  });

  it('hashes whatever arrives in a cookie without complaint', () => {
    // A cookie value is attacker-controlled. Nothing here parses or trusts it:
    // a garbage string becomes a digest that matches no row, which is the same
    // outcome as a token that has been revoked.
    const arbitrary = [
      ' ',
      '\t\n',
      '{}',
      '../../etc/passwd',
      "'; DROP TABLE sessions;--",
      '\u0000\u0001',
      '😀🔑',
      'a'.repeat(100_000),
      'not.a.jwt.at.all',
    ];
    for (const value of arbitrary) {
      expect(() => hashSessionToken(value), JSON.stringify(value)).not.toThrow();
      expect(hashSessionToken(value)).toMatch(HEX_64);
    }
  });
});
