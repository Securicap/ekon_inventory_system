import type { InventoryLocation } from '@ekon/shared';
import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';

/**
 * Inventory-location persistence. Hand-written SQL, a typed row shape kept
 * internal to the backend, and mapping to the shared wire type in one place.
 */

type Queryable = DatabasePool | DatabaseClient;

interface LocationRow {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Lists every location, active and inactive. Deterministic order: the default
 * location first, then by creation time, then by id as a stable tie-breaker.
 */
export async function listLocations(db: Queryable): Promise<InventoryLocation[]> {
  const { rows } = await db.query<LocationRow>(
    `SELECT id, name, is_default, is_active, created_at, updated_at
       FROM inventory_locations
      ORDER BY is_default DESC, created_at, id`,
  );
  return rows.map(toLocation);
}

function toLocation(row: LocationRow): InventoryLocation {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
