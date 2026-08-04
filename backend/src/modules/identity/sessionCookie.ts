import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Config } from '../../config/index.js';

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
 * `secure` is set only in production, where TLS is terminated in front of the
 * application. Setting it unconditionally would mean no cookie survives plain
 * `http://localhost`, and no injection test — which speaks http — could observe
 * one either; a browser silently drops a `Secure` cookie on an insecure origin
 * rather than reporting anything.
 *
 * The cookie is not signed. Signing protects a value the server needs to trust
 * on sight; this one is trusted only after its hash matches a row, which is a
 * stronger check than a signature and needs no secret to keep.
 */
export function sessionCookieOptions(nodeEnv: Config['NODE_ENV']): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    secure: nodeEnv === 'production',
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
export function clearSessionCookieOptions(nodeEnv: Config['NODE_ENV']): CookieSerializeOptions {
  const { maxAge: _maxAge, ...rest } = sessionCookieOptions(nodeEnv);
  return rest;
}
