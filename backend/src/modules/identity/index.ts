import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config/index.js';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import {
  createIdentityAuthService,
  type AuthServiceDeps,
  type IdentityAuthService,
} from './authService.js';
import { registerIdentityRoutes } from './routes.js';

/**
 * The identity module's composition entry point. The application root calls
 * this; nothing outside the module reaches into `domain/` or `infrastructure/`,
 * and no other module touches `users`, `sessions`, or `role_capabilities`.
 *
 * What is registered here is authentication and nothing more: login, logout,
 * and `/api/auth/me`. There is still no authentication hook, no request
 * principal, and no capability enforcement — the catalog and inventory routes
 * declare the capability they will require and remain unauthenticated until the
 * PR that wires that up. The initial-owner bootstrap is exported but not
 * registered: it has no HTTP surface and is run by an operator command.
 *
 * `@fastify/cookie` must be registered on the instance before these routes run.
 * The application root does that once, alongside its other plugins.
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
  registerIdentityRoutes(app, service, deps.config.NODE_ENV);
  return service;
}

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
