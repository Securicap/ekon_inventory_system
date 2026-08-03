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
