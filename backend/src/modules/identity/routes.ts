import type { FastifyInstance } from 'fastify';
import { loginRequestSchema, type AuthenticatedUserResponse } from '@ekon/shared';
import type { Config } from '../../config/index.js';
import type { IdentityAuthService } from './authService.js';
import { requireActor } from './routeAccess.js';
import {
  clearSessionCookieOptions,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from './sessionCookie.js';

/**
 * The authentication HTTP surface: sign in, sign out, and ask who you are.
 *
 * Login and logout are public — they are how a session is obtained and given
 * up, so requiring one would be circular. `/me` is authenticated-only: it needs
 * a valid session and no particular capability, and the enforcement hook has
 * already resolved the actor by the time its handler runs.
 *
 * None of the three carries an operation id. The header exists so that a
 * retried movement is posted once, and signing in is not a ledger command:
 * replaying it should mint a *new* session, not return the earlier one, and
 * writing an `operations` row for it would make the login path idempotent in
 * exactly the way it must not be.
 */
export function registerIdentityRoutes(
  app: FastifyInstance,
  service: IdentityAuthService,
  nodeEnv: Config['NODE_ENV'],
): void {
  /**
   * Sign in. The request carries a username and a password and nothing else —
   * no user id, no role, no capability list, no session lifetime, no cookie
   * option. Everything about the session is decided here, from the credential;
   * the strict shared schema is what makes a request that tries otherwise a 400
   * rather than a field that is quietly ignored.
   */
  app.post('/api/auth/login', { config: { auth: 'public' } }, async (request, reply) => {
    const input = loginRequestSchema.parse(request.body);
    const { user, rawSessionToken } = await service.login(input);

    // The one place the raw token leaves the server, and it leaves in a header
    // the browser will not show to JavaScript. It is deliberately not in the
    // body below: a token in JSON is a token in a fetch response, a devtools
    // network pane, and whatever the client decides to keep.
    void reply.setCookie(SESSION_COOKIE_NAME, rawSessionToken, sessionCookieOptions(nodeEnv));

    const body: AuthenticatedUserResponse = { user };
    return reply.status(200).send(body);
  });

  /**
   * Sign out. Revokes the presented session — that one, not every session the
   * person has — and clears the cookie either way.
   *
   * Always 204, and never a hint about what the cookie contained. A missing
   * cookie, an invented one, an expired one, and a second logout of the same
   * session all end with the browser holding nothing, which is the whole of
   * what the caller asked for.
   */
  app.post('/api/auth/logout', { config: { auth: 'public' } }, async (request, reply) => {
    await service.logout(request.cookies[SESSION_COOKIE_NAME] ?? null);

    // Cleared even when nothing was revoked. The browser's copy is the part
    // this route can actually guarantee, and leaving a dead token in it would
    // mean the next request still presents a credential.
    void reply.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions(nodeEnv));

    return reply.status(204).send();
  });

  /**
   * Who the caller is, resolved from the session on every call — current role,
   * current capabilities. This is how a demotion reaches the screen without the
   * person signing out.
   *
   * The handler no longer authenticates: the enforcement hook did it, once, and
   * left the result on the request. Doing it again here would be a second
   * session lookup per call for an answer the request already carries, and two
   * places that could disagree about who is signed in.
   *
   * Read-only: it does not extend the session, does not stamp an activity
   * timestamp, and does not clear the cookie when the session turns out to be
   * unusable. A read that also mutated would make the twelve hours slide, and
   * clearing on 401 would mean the browser's state depended on which endpoint
   * happened to be called first.
   *
   * One answer for all five ways this can fail — no cookie, an unknown token,
   * expired, revoked, deactivated — and it comes from the hook, so it is the
   * same answer every protected route gives. The client's next move is the same
   * in every case: sign in.
   */
  app.get('/api/auth/me', { config: { auth: 'authenticated' } }, async (request, reply) => {
    const body: AuthenticatedUserResponse = { user: requireActor(request) };
    return reply.status(200).send(body);
  });
}
