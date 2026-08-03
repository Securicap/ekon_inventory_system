import { z } from 'zod';

/**
 * Authorization is capability-based. Application code asks
 * `requireCapability(actor, 'inventory.adjust')` and never
 * `if (user.role === 'MANAGER')`. That discipline is what lets the role model
 * change later without touching business logic.
 *
 * The role -> capability mapping lives in the `role_capabilities` table and is
 * seeded by migration. This list is the vocabulary; the database holds the
 * assignment.
 */
export const CAPABILITIES = [
  'catalog.read',
  'catalog.write',
  'catalog.deactivate',
  'inventory.read',
  'inventory.receive',
  'inventory.adjust',
  'inventory.count',
  'inventory.reverse',
  'audit.read',
  'identity.manage',
  'reports.export',
] as const;

export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

/**
 * The intended seed for `role_capabilities`. Kept here so the frontend can
 * render role descriptions without a round trip, and so the seed migration and
 * the UI cannot drift apart.
 *
 * Note: there is deliberately no capability that permits negative stock. Stock
 * below zero is forbidden by database constraint on every code path; the remedy
 * for a shortfall is to record the missing receipt or run a physical count.
 */
export const DEFAULT_ROLE_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> = {
  SUPER_ADMIN: CAPABILITIES,
  OWNER: CAPABILITIES,
  MANAGER: CAPABILITIES.filter((c) => c !== 'identity.manage'),
  EMPLOYEE: [
    'catalog.read',
    'catalog.write',
    'inventory.read',
    'inventory.receive',
    'inventory.adjust',
    'inventory.count',
  ],
} as const;
