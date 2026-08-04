import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config/index.js';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import {
  createIdentityAuthService,
  type AuthServiceDeps,
  type IdentityAuthService,
} from './authService.js';
import { installAccessEnforcement } from './enforcement.js';
import { registerIdentityRoutes } from './routes.js';

/**
 * The identity module's composition entry point. The application root calls
 * this; nothing outside the module reaches into `domain/` or `infrastructure/`,
 * and no other module touches `users`, `sessions`, or `role_capabilities`.
 *
 * Three things happen here, in this order and for a reason:
 *
 *  1. the authentication service is created;
 *  2. **global access enforcement is installed on the whole application** — the
 *     startup check that every `/api/` route declares its access, and the hook
 *     that resolves the session and the capability on every request;
 *  3. the module's own routes are registered.
 *
 * Step 2 is why this call must come **before any other API route is
 * registered**, including the health check and every other module: the startup
 * check is an `onRoute` hook, and a hook only sees routes registered after it.
 * The composition root does that, and a test asserts an undeclared route fails
 * to register.
 *
 * The initial-owner bootstrap is exported but not registered: it has no HTTP
 * surface and is run by an operator command.
 *
 * `@fastify/cookie` must be registered on the instance before this, since the
 * enforcement hook reads the session cookie. The application root does that
 * once, alongside its other plugins.
 */
export function registerIdentity(
  app: FastifyInstance,
  deps: {
    config: Config;
    pool: DatabasePool;
    clock: Clock;
    generateId?: AuthServiceDeps['generateId'];
    generateSessionToken?: AuthServiceDeps['generateSessionToken'];
  },
): IdentityAuthService {
  const service = createIdentityAuthService(deps);
  installAccessEnforcement(app, service);
  registerIdentityRoutes(app, service, deps.config.NODE_ENV);
  return service;
}

/**
 * What other modules may use. A handler that needs to know who is acting takes
 * it from `requireActor(request)` — never from a body, a header, or a
 * parameter. Receiving, adjustments, and every other state-changing workflow
 * will get their `userId` this way.
 */
export { requireActor, RouteAccessDeclarationError } from './routeAccess.js';
export type { RouteAccess } from './routeAccess.js';

export { createIdentityAuthService } from './authService.js';
export type {
  AuthServiceDeps,
  IdentityAuthService,
  LoginCommand,
  LoginResult,
} from './authService.js';

export { createIdentityBootstrapService } from './bootstrapService.js';
export type {
  BootstrapServiceDeps,
  CreateInitialOwnerInput,
  IdentityBootstrapService,
  InitialOwnerCreated,
} from './bootstrapService.js';

export {
  assertPasswordAcceptable,
  hashPassword,
  verifyPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './domain/password.js';

export {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from './sessionCookie.js';
