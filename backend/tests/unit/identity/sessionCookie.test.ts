import { describe, expect, it } from 'vitest';
import {
  clearSessionCookieOptions,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from '../../../src/modules/identity/sessionCookie.js';

/**
 * The cookie the session travels in. Every attribute here is a security
 * property, and the integration tests assert them again on a real `set-cookie`
 * header — this file is where the reasoning is checked directly.
 */

describe('sessionCookieOptions', () => {
  it('is http-only, same-site, and rooted at the application', () => {
    // httpOnly is the attribute that makes an injected script unable to walk
    // away with a session; SameSite=Lax is what stops another site posting as
    // whoever is signed in.
    expect(sessionCookieOptions('production')).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('expires with the session it carries', () => {
    expect(SESSION_ABSOLUTE_LIFETIME_MS).toBe(12 * 60 * 60 * 1000);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(43_200);
    expect(sessionCookieOptions('test').maxAge).toBe(SESSION_ABSOLUTE_LIFETIME_MS / 1000);
  });

  it('is Secure in production and not in development', () => {
    // Unconditionally secure would mean no cookie survives plain
    // http://localhost — and a browser drops it silently rather than saying so.
    expect(sessionCookieOptions('production').secure).toBe(true);
    expect(sessionCookieOptions('development').secure).toBe(false);
    expect(sessionCookieOptions('test').secure).toBe(false);
  });

  it('stays host-only', () => {
    // One origin serves the API and the pages, so there is no second host to
    // share the session with and no subdomain that should inherit it.
    expect(sessionCookieOptions('production').domain).toBeUndefined();
  });

  it('does not name what it holds', () => {
    expect(SESSION_COOKIE_NAME).toBe('ekon_session');
    for (const word of ['token', 'hash', 'jwt', 'secret', 'auth']) {
      expect(SESSION_COOKIE_NAME).not.toContain(word);
    }
  });
});

describe('clearSessionCookieOptions', () => {
  it('matches the attributes the cookie was set with', () => {
    // A browser matches a deletion by name, path, and domain. Any difference
    // and the old cookie simply stays where it is.
    for (const env of ['production', 'development', 'test'] as const) {
      const set = sessionCookieOptions(env);
      const cleared = clearSessionCookieOptions(env);
      expect(cleared.path).toBe(set.path);
      expect(cleared.domain).toBe(set.domain);
      expect(cleared.sameSite).toBe(set.sameSite);
      expect(cleared.httpOnly).toBe(set.httpOnly);
      expect(cleared.secure).toBe(set.secure);
    }
  });

  it('carries no max-age of its own', () => {
    // The clearing mechanism supplies an expiry in the past; a lifetime here
    // would fight it.
    expect(clearSessionCookieOptions('production').maxAge).toBeUndefined();
  });
});
