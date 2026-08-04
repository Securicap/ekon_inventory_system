/**
 * The identity module's composition entry point.
 *
 * There is no `registerIdentity(app, deps)` yet, because the module has no HTTP
 * surface: no login route, no logout, no `/api/auth/me`, no authentication hook,
 * and no capability enforcement. This PR builds the data model, the password
 * utility, and the one-time owner bootstrap the later PRs need.
 *
 * What is exported is what the application root and the bootstrap command are
 * allowed to use. Nothing outside this module may reach into `domain/` or
 * `infrastructure/`, and no other module may touch `users`, `sessions`, or
 * `role_capabilities` directly.
 */

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
