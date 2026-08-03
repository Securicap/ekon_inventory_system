import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from '../../platform/db/pool.js';
import { registerInventoryRoutes } from './routes.js';
import { createInventoryService, type InventoryService } from './service.js';

/**
 * The inventory module's composition entry point. The application root calls
 * this; nothing reaches into the module's `infrastructure/` internals.
 *
 * The posting engine is exported below but deliberately not registered here.
 * It has no HTTP surface: no route, no request schema, no handler. Receiving,
 * adjustments, counts, and reversal are the workflows that will call it, and
 * each arrives with its own PR.
 */
export function registerInventory(
  app: FastifyInstance,
  deps: { pool: DatabasePool },
): InventoryService {
  const service = createInventoryService(deps);
  registerInventoryRoutes(app, service);
  return service;
}

export { createInventoryService } from './service.js';
export type { InventoryService } from './service.js';

export { createLedgerService } from './ledgerService.js';
export type {
  LedgerService,
  LedgerServiceDeps,
  PostableMovementType,
  PostMovementCommand,
} from './ledgerService.js';
export type { PostedMovement } from './infrastructure/ledgerRepository.js';
