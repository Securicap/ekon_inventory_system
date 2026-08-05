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
 * A location, as a workflow about to move stock needs to see it: does it exist,
 * and may stock still be put there. Never crosses the wire, so it carries none
 * of the presentation fields.
 */
export interface StockableLocation {
  id: string;
  /** Locations deactivate rather than delete once they carry history. */
  isActive: boolean;
}

/**
 * A location as a stock view needs to label it: no timestamps, and no
 * `is_active`, because the list is already filtered to the active ones.
 */
export interface ActiveLocation {
  id: string;
  name: string;
  isDefault: boolean;
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

/**
 * The places stock may currently sit — active locations only.
 *
 * Deliberately a different query from `listLocations`, not a filter applied to
 * its result. That one is the location *screen*, which must show a closed
 * location so somebody can see it is closed; this one is the set of shelves an
 * operational stock view is about, and a closed shelf is not one of them.
 *
 * Ordered default first, then by name, then by id — the order these appear in
 * within each variant. By name rather than by creation time, because this list
 * is read as columns of a grid by somebody who is looking for a place they know
 * the name of.
 */
export async function listActiveLocations(db: Queryable): Promise<ActiveLocation[]> {
  const { rows } = await db.query<Pick<LocationRow, 'id' | 'name' | 'is_default'>>(
    `SELECT id, name, is_default
       FROM inventory_locations
      WHERE is_active
      ORDER BY is_default DESC, name, id`,
  );
  return rows.map((row) => ({ id: row.id, name: row.name, isDefault: row.is_default }));
}

/**
 * Reads the one thing a stock workflow has to know before it posts: whether
 * this location exists, and whether stock may still be put there.
 *
 * Two columns rather than the whole row and its wire mapping, because a
 * receiving request is not a location screen. The `is_active` flag is returned
 * rather than acted on — what an inactive location means is the calling
 * workflow's decision.
 */
export async function findLocationForStock(
  db: Queryable,
  locationId: string,
): Promise<StockableLocation | null> {
  const { rows } = await db.query<Pick<LocationRow, 'id' | 'is_active'>>(
    `SELECT id, is_active
       FROM inventory_locations
      WHERE id = $1`,
    [locationId],
  );
  const row = rows[0];
  return row ? { id: row.id, isActive: row.is_active } : null;
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
