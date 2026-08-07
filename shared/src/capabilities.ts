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
  'inventory.remove',
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
   * An employee reads the catalog, reads stock, books in what arrives, and
   * records what leaves. That is the whole job at the counter, and the last of
   * those is why `inventory.remove` is here: selling a bottle, discarding a
   * broken one, and taking one for the shop's own use are what an employee
   * does all day. An operating model that made somebody fetch a manager to
   * record a sale would be an operating model nobody used — the stock would
   * leave the shelf anyway and the ledger would be the only thing that did not
   * know.
   *
   * `inventory.adjust` is deliberately **not** granted alongside it, and the
   * distinction is the whole point of having two capabilities. Removing stock
   * says what happened; adjusting it says the record was wrong. The second can
   * make a shortfall disappear, so it is the one that has to be given on
   * purpose.
   *
   * Everything else is withheld until someone decides otherwise: writing the
   * catalog, deactivating a product, adjusting or counting stock, reversing a
   * movement, reading the audit log, managing users, exporting reports. Each of
   * those either changes what the numbers mean or can hide the fact that they
   * changed.
   *
   * A shop that wants its employees to run counts grants that later. Starting
   * permissive and tightening afterwards is the wrong direction: by then people
   * are used to the access, and taking it back reads as an accusation.
   */
  EMPLOYEE: ['catalog.read', 'inventory.read', 'inventory.receive', 'inventory.remove'],
} as const;
