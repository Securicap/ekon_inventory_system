import { z } from 'zod';

/**
 * Inventory location contracts.
 *
 * A location is a place stock can sit. This first release ships exactly one —
 * the seeded default "Main Store" — and only lists them; creating, renaming, and
 * deactivating locations, and any multi-location stock behaviour, come later.
 * Read-only, so there is no request schema.
 */

/** Enforced maximum location name length, mirrored by a CHECK in the migration. */
export const LOCATION_NAME_MAX_LENGTH = 120;

export const inventoryLocationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Exactly one location is the default; a partial unique index enforces it. */
  isDefault: z.boolean(),
  /** Locations deactivate rather than delete once they carry history. */
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type InventoryLocation = z.infer<typeof inventoryLocationSchema>;

/** The location list is a plain array; the default location comes first. */
export const listInventoryLocationsResponseSchema = z.array(inventoryLocationSchema);

export type ListInventoryLocationsResponse = z.infer<typeof listInventoryLocationsResponseSchema>;
