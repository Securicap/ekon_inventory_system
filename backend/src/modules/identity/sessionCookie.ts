import type { CookieSerializeOptions } from '@fastify/cookie';

/**
 * How long a session lasts, and the cookie that carries it.
 *
 * The lifetime and the cookie's `Max-Age` are one constant on purpose. If they
 * were two, the pair would eventually disagree, and the disagreement would be
 * invisible in either direction: a cookie outliving its row means a browser
 * that keeps presenting a token the server has already stopped accepting, and a
 * row outliving its cookie means sessions accumulating in the table that
 * nothing will ever revoke.
 */

/**
 * Twelve hours, absolute, from the moment of signing in.
 *
 * There is no idle timeout, no sliding expiration, and no "remember me". A
 * sliding window is the option that quietly never ends — a browser left open on
 * a tab that polls keeps a session alive indefinitely — and an idle timeout
 * signs out the person mid-count with nothing but a lost form to show for it.
 * A fixed twelve hours covers any single working day and is over by the next
 * one, which is a rule that can be stated to the people who have to live with
 * it: you sign in once a day.
 *
 * It is a code constant rather than configuration. Nothing about this
 * deployment varies by environment, and a configurable session lifetime is a
 * setting nobody revisits until the day somebody sets it to a year.
 */
export const SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** The same twelve hours, in the unit `Max-Age` is expressed in: 43200. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_ABSOLUTE_LIFETIME_MS / 1000;

/**
 * Deliberately says nothing about what is inside it. Not `token`, not `hash`,
 * not `jwt` — a cookie name is visible to anyone with the browser open, and
 * naming the mechanism only tells them where to start.
 */
export const SESSION_COOKIE_NAME = 'ekon_session';

/**
 * The attributes the session cookie is set with, and cleared with.
 *
 * - `httpOnly` — frontend JavaScript cannot read the token. This is the one
 *   attribute that makes an injected script unable to walk away with a
 *   session, and it is why no part of the frontend ever handles a token, and
 *   why nothing is kept in local or session storage.
 * - `sameSite: 'lax'` — the browser will not attach this cookie to a
 *   cross-site POST, which is what stops another site from posting a movement
 *   as whoever is signed in. `strict` would additionally break following a
 *   link into the application while signed in; `lax` keeps top-level
 *   navigation working and refuses the request shapes that matter.
 * - `path: '/'` — one session for the whole application, API and pages alike.
 * - `maxAge` — matches the row's expiry, so a browser stops presenting a token
 *   the server would refuse anyway.
 * - no `domain` — the cookie stays host-only. The application is served from a
 *   single origin, backend and frontend together (see `registerFrontend`), so
 *   there is no second host to share it with and no subdomain that should
 *   inherit it.
 *
 * `secure` is passed in, from `SESSION_COOKIE_SECURE`, and is the one attribute
 * this module does not decide for itself. It is a fact about the origin the
 * application is served from, which only the configuration knows: `true` behind
 * a proxy terminating TLS, `false` for an installation a browser reaches at
 * `http://127.0.0.1` on the same computer (ADR 13).
 *
 * It is deliberately no longer derived from `NODE_ENV`. The production target
 * is now plain HTTP over loopback, so "production implies TLS" would set
 * `Secure` on a cookie the browser then drops — silently, with no error and no
 * warning — and nobody in the shop could sign in.
 *
 * The cookie is not signed. Signing protects a value the server needs to trust
 * on sight; this one is trusted only after its hash matches a row, which is a
 * stronger check than a signature and needs no secret to keep.
 */
export function sessionCookieOptions(secure: boolean): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    secure,
  };
}

/**
 * The attributes the cookie is *cleared* with.
 *
 * A browser matches a deletion to an existing cookie by name, path, and domain,
 * so those have to be identical to the ones it was set with or the old cookie
 * simply stays where it is. Deriving them from the same function is what makes
 * that true rather than customary. `maxAge` is dropped: the clearing mechanism
 * supplies its own expiry in the past.
 */
export function clearSessionCookieOptions(secure: boolean): CookieSerializeOptions {
  const { maxAge: _maxAge, ...rest } = sessionCookieOptions(secure);
  return rest;
}
