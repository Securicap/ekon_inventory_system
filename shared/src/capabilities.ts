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
  /**
   * An employee reads the catalog, reads stock, and books in what arrives. That
   * is the whole job at the counter.
   *
   * Everything else is deliberately withheld until someone decides otherwise:
   * writing the catalog, deactivating a product, adjusting or counting stock,
   * reversing a movement, reading the audit log, managing users, exporting
   * reports. Each of those either changes what the numbers mean or can hide the
   * fact that they changed, so the person doing it should have been given the
   * capability on purpose rather than inheriting it from a default.
   *
   * A shop that wants its employees to run counts grants that later. Starting
   * permissive and tightening afterwards is the wrong direction: by then people
   * are used to the access, and taking it back reads as an accusation.
   */
  EMPLOYEE: ['catalog.read', 'inventory.read', 'inventory.receive'],
} as const;
