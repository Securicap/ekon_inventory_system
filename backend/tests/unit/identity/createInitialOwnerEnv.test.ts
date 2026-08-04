import { describe, expect, it } from 'vitest';
import { OWNER_ENV_VARS, readOwnerInputFromEnv } from '../../../src/cli/createInitialOwner.js';

/**
 * The bootstrap command's input handling.
 *
 * Every case here is driven by an explicit environment object, never
 * `process.env`: a test that reads the developer's real environment passes or
 * fails depending on whose machine it runs on, and this particular one would
 * pass on the machine of anyone who had ever created an owner.
 *
 * Importing this module must also be inert — no database connection, no user
 * created. The command only runs when the file is the process entry point.
 */

const COMPLETE = {
  [OWNER_ENV_VARS.username]: 'marie.j',
  [OWNER_ENV_VARS.displayName]: 'Marie Joseph',
  [OWNER_ENV_VARS.password]: 'correct horse battery staple',
};

describe('readOwnerInputFromEnv', () => {
  it('reads the three required variables', () => {
    expect(readOwnerInputFromEnv(COMPLETE)).toEqual({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: 'correct horse battery staple',
    });
  });

  it('names every missing variable at once, so the operator fixes them in one go', () => {
    try {
      readOwnerInputFromEnv({});
      expect.unreachable('expected a validation error');
    } catch (error) {
      const message = (error as Error).message;
      for (const name of Object.values(OWNER_ENV_VARS)) {
        expect(message, `${name} should be reported missing`).toContain(name);
      }
    }
  });

  it('refuses when any single variable is missing', () => {
    for (const name of Object.values(OWNER_ENV_VARS)) {
      const partial = { ...COMPLETE };
      delete partial[name];
      expect(() => readOwnerInputFromEnv(partial), name).toThrow(new RegExp(name));
    }
  });

  it('treats an empty variable as missing, because that is what an unset one expands to', () => {
    expect(() => readOwnerInputFromEnv({ ...COMPLETE, [OWNER_ENV_VARS.password]: '' })).toThrow(
      new RegExp(OWNER_ENV_VARS.password),
    );
  });

  it('does not trim the password', () => {
    // A leading or trailing space is a character the person chose. Trimming it
    // would mean the password that was set is not the password that works.
    const padded = '  spaced out passphrase  ';
    expect(readOwnerInputFromEnv({ ...COMPLETE, [OWNER_ENV_VARS.password]: padded }).password).toBe(
      padded,
    );
  });

  it('leaves the username as typed, for the service to normalize', () => {
    // Normalization is the shared schema's job and happens in exactly one
    // place, so the CLI and a future HTTP handler cannot disagree about it.
    expect(
      readOwnerInputFromEnv({ ...COMPLETE, [OWNER_ENV_VARS.username]: '  Marie.J  ' }).username,
    ).toBe('  Marie.J  ');
  });

  it('never repeats the password in the error it raises', () => {
    const secret = 'this-should-never-be-echoed';
    try {
      readOwnerInputFromEnv({ [OWNER_ENV_VARS.password]: secret });
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
