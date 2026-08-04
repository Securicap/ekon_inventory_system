import type { AuthenticatedUser, Capability } from '@ekon/shared';

/**
 * What the signed-in person may do — asked as a capability, never as a role.
 *
 * `hasCapability(user, 'catalog.read')`, never `user.role === 'OWNER'`. The
 * backend authorizes this way (see `backend/src/modules/identity/`), and a
 * screen that branched on a role name would be a second, quietly different
 * answer to the same question — one that a change to `role_capabilities` would
 * not reach.
 *
 * This decides what is *shown*. It is not a security boundary: capabilities
 * arrive from `/api/auth/me` and live in the browser, where anything can be
 * edited. Every request is checked again by the server, which is the authority.
 * Hiding a link people cannot use is a usability property, and that is all.
 */
export function hasCapability(user: AuthenticatedUser, capability: Capability): boolean {
  return user.capabilities.includes(capability);
}
