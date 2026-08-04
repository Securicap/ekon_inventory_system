import type { FastifyInstance } from 'fastify';
import { AppError, forbidden, unauthenticated } from '../../platform/http/errors.js';
import type { IdentityAuthService } from './authService.js';
import { assertRouteAccessDeclared, isApiRoute, resolveRouteAccess } from './routeAccess.js';
import { SESSION_COOKIE_NAME } from './sessionCookie.js';

/**
 * Where every API request is admitted or refused.
 *
 * Two hooks, installed once on the root instance before any route is
 * registered:
 *
 *  - `onRoute` reads each route's access declaration as it is registered and
 *    refuses to start if an `/api/` route has none. That is what makes the
 *    protection below exhaustive rather than customary: a new endpoint cannot
 *    be added without saying what it is.
 *  - `onRequest` resolves the session cookie and checks the capability, before
 *    the handler and before anything the caller sent is parsed.
 *
 * Installed on the root scope deliberately. A hook added inside an encapsulated
 * plugin would guard that plugin's routes and silently leave every other
 * module's open — which is the exact failure this file exists to prevent, and
 * is invisible in a diff. Every module registers through the composition root,
 * which installs this first.
 *
 * `onRequest`, not `preHandler`, on purpose. It is the earliest point at which
 * the matched route is known, so an anonymous caller is refused *before* their
 * body is parsed, before validation runs, and before any handler code exists to
 * reach. The only work an unauthenticated request buys is one indexed session
 * lookup — and on a public route, not even that.
 */
export function installAccessEnforcement(app: FastifyInstance, service: IdentityAuthService): void {
  /**
   * Present on every request, including the ones nobody was asked to identify.
   * A property that sometimes exists is a property every reader has to check
   * twice, so it is `null` on a public route rather than absent.
   */
  app.decorateRequest('actor', null);

  app.addHook('onRoute', (routeOptions) => {
    assertRouteAccessDeclared({
      method: routeOptions.method,
      url: routeOptions.url,
      config: routeOptions.config,
    });
  });

  app.addHook('onRequest', async (request) => {
    const url = request.routeOptions.url;

    // No route matched. There is nothing to protect and nothing to leak: the
    // not-found handler answers, and it answers the same way whether or not a
    // session was presented.
    if (url === undefined) return;

    const access = resolveRouteAccess(
      request.routeOptions.config,
      `Route ${request.method} ${url}`,
    );

    if (access === null) {
      // The static frontend and the single-page fallback, which are public by
      // nature and declare nothing.
      if (!isApiRoute(url)) return;

      // Unreachable: the onRoute hook above refuses to register such a route.
      // Kept because the cost of being wrong here is an unprotected endpoint,
      // and a 500 is the right way to be wrong about that.
      throw new AppError('INTERNAL', 'Route has no access declaration');
    }

    // Public routes pay for nothing. Signing in and the health check must not
    // depend on the sessions table, and a login form that did a session lookup
    // before every attempt would be doing work on behalf of whoever was
    // hammering it.
    if (access.mode === 'public') return;

    // One lookup, through the identity service — the same call `/api/auth/me`
    // used to make for itself. It already refuses a missing, unknown, expired,
    // or revoked token and an inactive user, and resolves the role and
    // capabilities as they are *now*. No SQL is repeated here, and no other
    // module reads the sessions table.
    const actor = await service.authenticate(request.cookies[SESSION_COOKIE_NAME] ?? null);
    if (!actor) throw unauthenticated();

    request.actor = actor;

    // Authorization is by capability, never by role. Business code asks what
    // somebody may do, not who they are, which is what lets the role model
    // change without touching a handler.
    if (access.mode === 'capability' && !actor.capabilities.includes(access.capability)) {
      throw forbidden();
    }
  });
}
