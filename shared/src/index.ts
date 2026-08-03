/**
 * @ekon/shared — the single source of truth for anything that must mean the same
 * thing on both sides of the wire.
 *
 * Nothing in this package may import from `backend` or `frontend`. It has no
 * runtime dependencies beyond `zod`.
 */

export * from './roles.js';
export * from './capabilities.js';
export * from './movements.js';
export * from './errors.js';
export * from './http.js';
export * from './catalog.js';
export * from './inventoryLocations.js';
