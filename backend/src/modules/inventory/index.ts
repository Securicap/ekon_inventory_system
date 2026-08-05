import type { FastifyInstance } from 'fastify';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import type { CatalogService } from '../catalog/index.js';
import { createLedgerService, type LedgerService } from './ledgerService.js';
import { createReceivingService, type ReceivingService } from './receivingService.js';
import { registerInventoryRoutes } from './routes.js';
import { createInventoryService, type InventoryService } from './service.js';

/**
 * The inventory module's composition entry point. The application root calls
 * this; nothing reaches into the module's `domain/` or `infrastructure/`
 * internals.
 *
 * The posting engine is built here and still has **no HTTP surface of its
 * own** — no route, no request schema, no handler. Receiving is the first
 * workflow to call it, and calls it as any other will: describe the business
 * event, let the engine own the movement. Adjustments, counts, and reversal
 * arrive with their own PRs.
 *
 * The catalog service is a dependency rather than a set of tables: variants
 * belong to the catalog module, so receiving asks it whether one may be stocked
 * instead of reaching across the boundary into `product_variants`, and the stock
 * read asks it what is currently stockable instead of joining to `products`.
 */
export function registerInventory(
  app: FastifyInstance,
  deps: { pool: DatabasePool; clock: Clock; catalog: CatalogService },
): { inventory: InventoryService; ledger: LedgerService; receiving: ReceivingService } {
  const inventory = createInventoryService({ pool: deps.pool, catalog: deps.catalog });
  const ledger = createLedgerService({ pool: deps.pool, clock: deps.clock });
  const receiving = createReceivingService({ pool: deps.pool, ledger, catalog: deps.catalog });

  registerInventoryRoutes(app, { inventory, receiving });

  return { inventory, ledger, receiving };
}

export { createInventoryService } from './service.js';
export type { InventoryService, InventoryServiceDeps } from './service.js';

export { createLedgerService } from './ledgerService.js';
export type {
  LedgerService,
  LedgerServiceDeps,
  OperationClaim,
  PostableMovementType,
  PostMovementCommand,
} from './ledgerService.js';
export type { PostedMovement } from './infrastructure/ledgerRepository.js';

export { createReceivingService } from './receivingService.js';
export type {
  ReceiveStockCommand,
  ReceivingService,
  ReceivingServiceDeps,
} from './receivingService.js';

/** The `operations.operation_type` a receiving command claims its id under. */
export { RECEIVING_OPERATION_TYPE } from './domain/receivingRequestHash.js';
