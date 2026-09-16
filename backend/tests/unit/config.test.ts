import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const minimal = { DATABASE_URL: 'postgres://user:pw@localhost:5432/ekon' };

/** What a `local` installation has to state before it may start. */
const localDirectories = {
  EXPECTED_SCHEMA_VERSION: '0015',
  EKON_BACKUP_DIR: '/var/lib/ekon/backups',
  EKON_STATE_DIR: '/var/lib/ekon/state',
};

/** The message of whatever `run` threw, so a test can assert what it did *not* say. */
function captureError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected loadConfig to throw, and it did not.');
}

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

/**
 * The deployment profile says *what kind of installation this is*, which is a
 * different question from `NODE_ENV` and decides the three settings that
 * genuinely differ between a developer's laptop, a hosted deployment, and a
 * computer in a shop.
 */
describe('loadConfig — the deployment profile', () => {
  it('defaults to development, with the permissive settings', () => {
    const config = loadConfig(minimal);
    expect(config.DEPLOYMENT_PROFILE).toBe('development');
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.SESSION_COOKIE_SECURE).toBe(false);
    expect(config.DATABASE_SSL).toBe(false);
    expect(config.TRUST_PROXY).toBe(false);
  });

  it('binds a local installation to loopback and speaks plain http to it', () => {
    // ADR 13: both tiers listen on 127.0.0.1, nothing Ekon installs is
    // reachable from the shop's network, and the browser on the same machine
    // reaches it over http — so a `Secure` cookie would be dropped silently and
    // nobody could sign in.
    const config = loadConfig({ ...minimal, DEPLOYMENT_PROFILE: 'local', ...localDirectories });
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.SESSION_COOKIE_SECURE).toBe(false);
    expect(config.DATABASE_SSL).toBe(false);
  });

  it('keeps the hosted behaviour the application had before ADR 13', () => {
    const config = loadConfig({
      ...minimal,
      DEPLOYMENT_PROFILE: 'hosted',
      EXPECTED_SCHEMA_VERSION: '0015',
    });
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.SESSION_COOKIE_SECURE).toBe(true);
  });

  it('trusts forwarded headers only where something in front sets them', () => {
    // There is no reverse proxy in a local installation, so an
    // `X-Forwarded-For` there could only have come from the caller: trusting it
    // would let anyone choose the client address in the logs and buy nothing.
    expect(
      loadConfig({ ...minimal, DEPLOYMENT_PROFILE: 'hosted', EXPECTED_SCHEMA_VERSION: '0015' })
        .TRUST_PROXY,
    ).toBe(true);
    expect(
      loadConfig({ ...minimal, DEPLOYMENT_PROFILE: 'local', ...localDirectories }).TRUST_PROXY,
    ).toBe(false);
    expect(loadConfig(minimal).TRUST_PROXY).toBe(false);
  });

  it('lets an installation override a profile default', () => {
    const config = loadConfig({
      ...minimal,
      DEPLOYMENT_PROFILE: 'local',
      ...localDirectories,
      HOST: '192.168.1.10',
      SESSION_COOKIE_SECURE: 'true',
    });
    expect(config.HOST).toBe('192.168.1.10');
    expect(config.SESSION_COOKIE_SECURE).toBe(true);
  });

  it('treats a present-but-empty override as unset', () => {
    // `HOST=$UNDEFINED` in a shell script and a blank line in a generated
    // settings file both arrive as '', and neither is somebody choosing an
    // empty host.
    const config = loadConfig({
      ...minimal,
      DEPLOYMENT_PROFILE: 'local',
      ...localDirectories,
      HOST: '   ',
    });
    expect(config.HOST).toBe('127.0.0.1');
  });

  it('rejects a profile it does not know, and says so as the only problem', () => {
    // The unknown profile still gets the development defaults applied, so the
    // report names the one thing that is actually wrong rather than that plus
    // every variable whose default was never filled in.
    const error = captureError(() => loadConfig({ ...minimal, DEPLOYMENT_PROFILE: 'staging' }));
    expect(error).toMatch(/DEPLOYMENT_PROFILE/);
    expect(error).not.toMatch(/HOST/);
    expect(error).not.toMatch(/SESSION_COOKIE_SECURE/);
  });

  it('refuses a boolean that is almost a boolean', () => {
    expect(() => loadConfig({ ...minimal, SESSION_COOKIE_SECURE: '1' })).toThrow(
      /SESSION_COOKIE_SECURE/,
    );
    expect(() => loadConfig({ ...minimal, DATABASE_SSL: 'yes' })).toThrow(/DATABASE_SSL/);
  });
});

/**
 * An installation has to state where it keeps its own files and which schema it
 * expects, and has to do it before it takes a single request. A shop that
 * discovers its backup directory was never configured discovers it the night
 * the first backup did not run.
 */
describe('loadConfig — what a local installation must state', () => {
  const local = { ...minimal, DEPLOYMENT_PROFILE: 'local' };

  it('requires the schema pin, the backup directory, and the state directory', () => {
    const error = captureError(() => loadConfig(local));
    expect(error).toMatch(/EXPECTED_SCHEMA_VERSION/);
    expect(error).toMatch(/EKON_BACKUP_DIR/);
    expect(error).toMatch(/EKON_STATE_DIR/);
  });

  it('names all three at once so an installation is fixed in one pass', () => {
    const error = captureError(() => loadConfig({ DEPLOYMENT_PROFILE: 'local' }));
    expect(error).toMatch(/DATABASE_URL[\s\S]*EXPECTED_SCHEMA_VERSION/);
  });

  it('refuses a blank directory as firmly as a missing one', () => {
    expect(() => loadConfig({ ...local, ...localDirectories, EKON_BACKUP_DIR: '   ' })).toThrow(
      /EKON_BACKUP_DIR/,
    );
  });

  it('starts when they are all there', () => {
    const config = loadConfig({ ...local, ...localDirectories });
    expect(config.EXPECTED_SCHEMA_VERSION).toBe('0015');
    expect(config.EKON_BACKUP_DIR).toBe('/var/lib/ekon/backups');
    expect(config.EKON_STATE_DIR).toBe('/var/lib/ekon/state');
  });

  it('leaves the directories optional everywhere else', () => {
    expect(loadConfig(minimal).EKON_BACKUP_DIR).toBeUndefined();
    expect(
      loadConfig({ ...minimal, DEPLOYMENT_PROFILE: 'hosted', EXPECTED_SCHEMA_VERSION: '0015' })
        .EKON_STATE_DIR,
    ).toBeUndefined();
  });

  it('requires a schema pin under hosted too', () => {
    expect(() => loadConfig({ ...minimal, DEPLOYMENT_PROFILE: 'hosted' })).toThrow(
      /EXPECTED_SCHEMA_VERSION is required/,
    );
  });
});

describe('loadConfig — waiting for the database', () => {
  it('waits a minute by default', () => {
    // Windows starts Ekon and Ekon PostgreSQL together and gives no ordering
    // guarantee; on shop hardware the database can take twenty seconds.
    expect(loadConfig(minimal).DATABASE_WAIT_TIMEOUT_MS).toBe(60_000);
  });

  it('is configurable, within bounds', () => {
    expect(
      loadConfig({ ...minimal, DATABASE_WAIT_TIMEOUT_MS: '5000' }).DATABASE_WAIT_TIMEOUT_MS,
    ).toBe(5000);
    expect(() => loadConfig({ ...minimal, DATABASE_WAIT_TIMEOUT_MS: '99999999' })).toThrow(
      /DATABASE_WAIT_TIMEOUT_MS/,
    );
  });
});

describe('loadConfig — retention', () => {
  it('keeps a fortnight of days and two months of weeks by default', () => {
    const config = loadConfig(minimal);
    expect(config.BACKUP_KEEP_DAILY).toBe(14);
    expect(config.BACKUP_KEEP_WEEKLY).toBe(8);
  });

  it('refuses to keep nothing', () => {
    expect(() => loadConfig({ ...minimal, BACKUP_KEEP_DAILY: '0' })).toThrow(/BACKUP_KEEP_DAILY/);
  });
});
