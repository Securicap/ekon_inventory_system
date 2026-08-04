import {
  CAPABILITIES,
  capabilitySchema,
  type AuthenticatedUser,
  type Capability,
} from '@ekon/shared';
import type { FastifyContextConfig, FastifyRequest } from 'fastify';
import { AppError } from '../../platform/http/errors.js';

/**
 * What a route says about who may call it, and who the caller turned out to be.
 *
 * Every route under `/api/` declares one of three things, in its route
 * `config`, next to the handler it guards:
 *
 * ```ts
 * { config: { auth: 'public' } }              // no session needed
 * { config: { auth: 'authenticated' } }       // a session, but no capability
 * { config: { capability: 'catalog.write' } } // a session that may do this
 * ```
 *
 * A capability declaration implies authentication — writing both would be two
 * statements of one fact, and two statements can disagree. Declaring both is a
 * startup failure rather than a precedence rule, because a precedence rule is
 * something a reader has to know and a failure is something they are told.
 *
 * The declaration lives on the route because that is where a reviewer reads it:
 * a central list of protected paths is a list that drifts from the routes it
 * describes, and the drift is invisible until the day an endpoint is missing
 * from it. Nothing is protected by being absent from a list here — a route with
 * no declaration at all does not start.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * `public` — anyone may call this, and no session is looked up.
     * `authenticated` — a valid session is required, but nothing beyond it.
     *
     * Omitted when the route declares a `capability` instead.
     */
    auth?: 'public' | 'authenticated';
    /**
     * The capability the caller must hold. Implies a valid session.
     *
     * Typed as the shared `Capability` union rather than `string`, so a
     * misspelt or invented capability is a compile error at the route that
     * declares it — long before the runtime check below has to catch it.
     */
    capability?: Capability;
  }

  interface FastifyRequest {
    /**
     * The person making this request, resolved from the session cookie by the
     * enforcement hook — or `null` on a public route, where nobody was asked.
     *
     * The *only* source of request identity. It is never read from a body, a
     * query parameter, a header, a route parameter, or an operation id: those
     * are all things the caller writes, and an actor the caller can write is
     * not an actor at all. Handlers that need the person should use
     * `requireActor`.
     */
    actor: AuthenticatedUser | null;
  }
}

/** The resolved meaning of a route's declaration. */
export type RouteAccess =
  { mode: 'public' } | { mode: 'authenticated' } | { mode: 'capability'; capability: Capability };

/**
 * A route declaration that cannot be honoured. Thrown while routes are being
 * registered, so the process fails to start rather than serving an endpoint
 * whose protection nobody can state.
 *
 * Not an `AppError`: no request is in flight, no client will ever see it, and
 * the audience is the developer who just added the route.
 */
export class RouteAccessDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteAccessDeclarationError';
  }
}

/** Routes under this prefix must declare their access. Everything else may not. */
export function isApiRoute(url: string): boolean {
  return url.startsWith('/api/');
}

/**
 * Reads a route's declaration.
 *
 * Returns `null` when the route declares nothing — which is legitimate for the
 * static frontend and the single-page fallback, and a startup failure for
 * anything under `/api/`. Throws when the declaration contradicts itself.
 *
 * `where` names the route in any error, because "a route declares both" is not
 * a message anybody can act on.
 */
export function resolveRouteAccess(
  config: FastifyContextConfig | undefined,
  where: string,
): RouteAccess | null {
  const auth = config?.auth;
  const capability = config?.capability;

  if (auth !== undefined && capability !== undefined) {
    throw new RouteAccessDeclarationError(
      `${where} declares both auth: '${auth}' and capability: '${capability}'. ` +
        'Declare one: a capability already requires a valid session, and two ' +
        'declarations of one fact can disagree.',
    );
  }

  if (auth !== undefined) {
    if (auth !== 'public' && auth !== 'authenticated') {
      throw new RouteAccessDeclarationError(
        `${where} declares auth: '${String(auth)}', which is not 'public' or 'authenticated'.`,
      );
    }
    return auth === 'public' ? { mode: 'public' } : { mode: 'authenticated' };
  }

  if (capability !== undefined) {
    // The type says this cannot happen; the check is here because a route
    // config can be built at runtime, and a capability that is not in the
    // vocabulary is one no actor can ever hold — a route nobody could call,
    // failing as a silent 403 forever rather than at startup.
    if (!capabilitySchema.safeParse(capability).success) {
      throw new RouteAccessDeclarationError(
        `${where} declares capability: '${String(capability)}', which is not a known capability. ` +
          `Known capabilities: ${CAPABILITIES.join(', ')}.`,
      );
    }
    return { mode: 'capability', capability };
  }

  return null;
}

/**
 * Checks one route's declaration as it is registered, and refuses the ones that
 * would leave an endpoint unprotected by accident.
 *
 * Two rules, deliberately different in scope:
 *
 *  - *Any* route that declares something must declare it coherently.
 *  - Every route under `/api/` must declare something.
 *
 * The second rule is the point of the whole mechanism. A developer adding an
 * endpoint a year from now does not have to remember to protect it; they have
 * to say what it is, and the application will not start until they do. Getting
 * it wrong is loud, and the failure mode of forgetting is a refusal to boot
 * rather than an open door.
 *
 * Fastify generates a `HEAD` route for every `GET`, carrying the same config
 * object, so those pass on the strength of the declaration their `GET` already
 * made. A hand-written `app.head('/api/...')` with no declaration still fails,
 * which is correct — it is an endpoint like any other.
 */
export function assertRouteAccessDeclared(route: {
  method: string | string[];
  url: string;
  config?: FastifyContextConfig | undefined;
}): void {
  const methods = Array.isArray(route.method) ? route.method.join('|') : route.method;
  const where = `Route ${methods} ${route.url}`;

  const access = resolveRouteAccess(route.config, where);
  if (access !== null) return;

  if (isApiRoute(route.url)) {
    throw new RouteAccessDeclarationError(
      `${where} declares no access policy. Every route under /api/ must declare exactly one of ` +
        "config: { auth: 'public' }, config: { auth: 'authenticated' }, or " +
        "config: { capability: '<capability>' }.",
    );
  }
}

/**
 * The person making this request, for a handler that needs one.
 *
 * Only valid in a handler whose route declared `auth: 'authenticated'` or a
 * capability — for those, the enforcement hook has already refused the request
 * if no actor could be resolved, so this cannot legitimately be null. If it is,
 * a route's declaration and its handler disagree about whether anybody is
 * signed in, which is a programming error and is treated as one: a 500 with a
 * request id, never a 401 that would suggest the caller could fix it by
 * signing in.
 *
 * It does not authenticate. There is one session lookup per request, in the
 * hook, and a helper that quietly performed a second one would make the cost of
 * reading the actor invisible at the call site.
 */
export function requireActor(request: FastifyRequest): AuthenticatedUser {
  if (request.actor) return request.actor;

  throw new AppError(
    'INTERNAL',
    'No authenticated actor on a route that requires one. The route is missing ' +
      "config: { auth: 'authenticated' } or a capability declaration.",
  );
}
