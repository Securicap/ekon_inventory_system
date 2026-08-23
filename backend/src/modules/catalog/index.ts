import type { FastifyInstance } from 'fastify';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import { registerCatalogRoutes } from './routes.js';
import { createCatalogService, type CatalogService, type CatalogServiceDeps } from './service.js';

/**
 * The catalog module's composition entry point. The application root calls this;
 * nothing reaches into the module's `domain/` or `infrastructure/` internals.
 */
export function registerCatalog(
  app: FastifyInstance,
  deps: {
    pool: DatabasePool;
    clock: Clock;
    generateSku?: CatalogServiceDeps['generateSku'] | undefined;
  },
): CatalogService {
  const service = createCatalogService(deps);
  registerCatalogRoutes(app, service);
  return service;
}

export { createCatalogService } from './service.js';
export type { CatalogService } from './service.js';

/**
 * What a variant looks like to a module that is about to move stock against it,
 * and what the currently stockable ones look like to a module that has to
 * present them. Re-exported here so the inventory module can name both types
 * without reaching into `infrastructure/`.
 */
export type {
  StockableVariant,
  StockableVariantListing,
  VariantLabel,
} from './infrastructure/catalogRepository.js';
