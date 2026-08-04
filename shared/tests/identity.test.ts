import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  displayNameSchema,
  normalizeUsername,
  usernameSchema,
} from '../src/index.js';

/**
 * The username rule is enforced in three places — this schema, the database
 * CHECK in migration 0007, and whatever form eventually creates a user. These
 * assertions pin the meaning; a backend integration test pins the database to
 * the same pattern.
 */
describe('username', () => {
  it('normalizes to the stored form: trimmed and lower-cased', () => {
    expect(normalizeUsername('  Marie.J  ')).toBe('marie.j');
    expect(usernameSchema.parse('  Marie.J  ')).toBe('marie.j');
    expect(usernameSchema.parse('MARIE')).toBe('marie');
  });

  it('treats a differently-cased username as the same account', () => {
    // Not `citext`, and not a separate display case: one canonical string is
    // stored, so a duplicate is an ordinary UNIQUE violation.
    expect(usernameSchema.parse('Marie')).toBe(usernameSchema.parse('marie'));
  });

  it('accepts the permitted characters', () => {
    for (const username of ['marie', 'jean-luc', 'j.smith', 'user_1', 'abc', 'a-b_c.9']) {
      expect(usernameSchema.safeParse(username).success, username).toBe(true);
    }
  });

  it('rejects characters outside the safe set', () => {
    // A username ends up in URLs, log lines, and shell commands. Keeping it to
    // an unambiguous alphabet means it never has to be quoted or escaped.
    for (const username of ['marie j', 'marie@shop', 'marie!', 'marié', 'marie/j', 'marie+1']) {
      expect(usernameSchema.safeParse(username).success, username).toBe(false);
    }
  });

  it('enforces the length bounds after trimming', () => {
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('  ab  ').success).toBe(false);
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MIN_LENGTH)).success).toBe(true);
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH)).success).toBe(true);
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('rejects a blank username', () => {
    expect(usernameSchema.safeParse('').success).toBe(false);
    expect(usernameSchema.safeParse('   ').success).toBe(false);
  });

  it('has a pattern that describes exactly the normalized stored form', () => {
    // Migration 0007 carries this same expression as a CHECK constraint.
    expect(USERNAME_PATTERN.source).toBe('^[a-z0-9._-]{3,40}$');
    expect(USERNAME_PATTERN.test('marie.j')).toBe(true);
    expect(USERNAME_PATTERN.test('Marie.J')).toBe(false);
    expect(USERNAME_PATTERN.test(' marie ')).toBe(false);
  });
});

describe('display name', () => {
  it('trims and preserves case', () => {
    expect(displayNameSchema.parse('  Marie Joseph  ')).toBe('Marie Joseph');
  });

  it('accepts accented and Creole names unchanged', () => {
    // Employees are named in Haitian Creole and French. A display name is a
    // person's name, not an identifier, and is not restricted to ASCII.
    expect(displayNameSchema.parse('Wélgentz Étienne')).toBe('Wélgentz Étienne');
  });

  it('rejects a blank display name', () => {
    expect(displayNameSchema.safeParse('').success).toBe(false);
    expect(displayNameSchema.safeParse('   ').success).toBe(false);
  });

  it('bounds the length', () => {
    expect(displayNameSchema.safeParse('a'.repeat(DISPLAY_NAME_MAX_LENGTH)).success).toBe(true);
    expect(displayNameSchema.safeParse('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });
});
