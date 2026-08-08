import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const minimal = { DATABASE_URL: 'postgres://user:pw@localhost:5432/ekon' };

describe('loadConfig', () => {
  it('applies defaults for everything optional', () => {
    const config = loadConfig(minimal);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.DATABASE_SSL).toBe(false);
    expect(config.DISPLAY_TIMEZONE).toBe('America/Port-au-Prince');
  });

  it('refuses to start without a database url', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('names every problem at once so a misconfigured deploy is fixed in one pass', () => {
    expect(() => loadConfig({ PORT: 'not-a-port', LOG_LEVEL: 'chatty' })).toThrow(
      /DATABASE_URL[\s\S]*PORT[\s\S]*LOG_LEVEL/,
    );
  });

  it('coerces numeric and boolean environment strings', () => {
    const config = loadConfig({ ...minimal, PORT: '8080', DATABASE_SSL: 'true' });
    expect(config.PORT).toBe(8080);
    expect(config.DATABASE_SSL).toBe(true);
  });

  it('rejects an unknown log level rather than silently defaulting', () => {
    expect(() => loadConfig({ ...minimal, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});

/**
 * The pin is what stands between a build and a database at a version it does
 * not understand: unset, the startup assertion is never reached at all. So the
 * requirement lives here, where a deploy is refused before anything opens a
 * connection — not as an environment check somewhere in the application.
 */
describe('loadConfig — the production schema pin', () => {
  const production = { ...minimal, NODE_ENV: 'production' };

  it('refuses to start production with no pin at all', () => {
    expect(() => loadConfig(production)).toThrow(/EXPECTED_SCHEMA_VERSION is required/);
  });

  it('refuses to start production with a blank pin', () => {
    // An empty variable is how this is set wrong in practice — a platform field
    // filled in and then cleared. It must not read as "unset, so skip".
    expect(() => loadConfig({ ...production, EXPECTED_SCHEMA_VERSION: '' })).toThrow(
      /EXPECTED_SCHEMA_VERSION/,
    );
    expect(() => loadConfig({ ...production, EXPECTED_SCHEMA_VERSION: '   ' })).toThrow(
      /EXPECTED_SCHEMA_VERSION/,
    );
  });

  it('refuses a value that could never be a migration version', () => {
    expect(() => loadConfig({ ...production, EXPECTED_SCHEMA_VERSION: '8' })).toThrow(
      /four-digit prefix of a migration filename/,
    );
    expect(() => loadConfig({ ...production, EXPECTED_SCHEMA_VERSION: 'head' })).toThrow(
      /four-digit prefix of a migration filename/,
    );
  });

  it('starts production when the pin is a migration version', () => {
    const config = loadConfig({ ...production, EXPECTED_SCHEMA_VERSION: '0007' });
    expect(config.NODE_ENV).toBe('production');
    expect(config.EXPECTED_SCHEMA_VERSION).toBe('0007');
  });

  it('forgives whitespace around a pasted value rather than failing the deploy', () => {
    expect(
      loadConfig({ ...production, EXPECTED_SCHEMA_VERSION: ' 0007\n' }).EXPECTED_SCHEMA_VERSION,
    ).toBe('0007');
  });

  it('still names every problem at once, so production is fixed in one pass', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL[\s\S]*EXPECTED_SCHEMA_VERSION/,
    );
  });

  it('lets development omit it', () => {
    // Requiring a pin locally would mean editing `.env` after every migration,
    // and the check it enables is meaningless against a database you migrate by
    // hand a minute earlier.
    expect(loadConfig(minimal).EXPECTED_SCHEMA_VERSION).toBeUndefined();
    expect(
      loadConfig({ ...minimal, NODE_ENV: 'development' }).EXPECTED_SCHEMA_VERSION,
    ).toBeUndefined();
  });

  it('lets test omit it', () => {
    expect(loadConfig({ ...minimal, NODE_ENV: 'test' }).EXPECTED_SCHEMA_VERSION).toBeUndefined();
  });

  it('validates a pin supplied outside production, rather than ignoring it', () => {
    expect(() => loadConfig({ ...minimal, EXPECTED_SCHEMA_VERSION: 'head' })).toThrow(
      /four-digit prefix of a migration filename/,
    );
  });
});
