import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from '../../platform/db/pool.js';
import { registerInventoryRoutes } from './routes.js';
import { createInventoryService, type InventoryService } from './service.js';

/**
 * The inventory module's composition entry point. The application root calls
 * this; nothing reaches into the module's `infrastructure/` internals.
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
