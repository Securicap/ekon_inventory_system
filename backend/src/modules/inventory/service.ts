import type { InventoryLocation } from '@ekon/shared';
import type { DatabasePool } from '../../platform/db/pool.js';
import { listLocations } from './infrastructure/locationRepository.js';

/**
 * The inventory application service — the module's public surface. Today it only
 * lists locations; the movement ledger and its rules arrive later.
 *
 * The one operation here is a read, so there is no transaction wrapper.
 */
export interface InventoryServiceDeps {
  pool: DatabasePool;
}

export interface InventoryService {
  listLocations(): Promise<InventoryLocation[]>;
}

export function createInventoryService(deps: InventoryServiceDeps): InventoryService {
  return {
    listLocations: () => listLocations(deps.pool),
  };
}
