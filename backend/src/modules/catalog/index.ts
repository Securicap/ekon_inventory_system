import type { FastifyInstance } from 'fastify';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import {
  createLifecycleService,
  type LifecycleService,
  type StockPresenceReader,
} from './lifecycleService.js';
import { registerCatalogRoutes } from './routes.js';
import { createCatalogService, type CatalogService, type CatalogServiceDeps } from './service.js';

/**
 * The catalog module's composition entry point. The application root calls this;
 * nothing reaches into the module's `domain/` or `infrastructure/` internals.
 *
 * Two application services, built here and returned separately. `CatalogService`
 * enters and reads merchandise; `LifecycleService` withdraws and restores it,
 * and is the only one that needs to know anything about stock — it takes the
 * `stock` port below, which the composition root satisfies with the inventory
 * module's narrow stock-presence reader. Keeping them apart is what stops the
 * product-creation path acquiring a dependency on inventory that it has no use
 * for.
 */
export function registerCatalog(
  app: FastifyInstance,
  deps: {
    pool: DatabasePool;
    clock: Clock;
    /**
     * What is on the shelf, asked of the inventory module.
     *
     * A port the catalog declares and another module fills. `inventory_balances`
     * is not this module's table and nothing here queries it — archive safety
     * needs the number, not the rows.
     */
    stock: StockPresenceReader;
    generateSku?: CatalogServiceDeps['generateSku'] | undefined;
  },
): { catalog: CatalogService; lifecycle: LifecycleService } {
  const catalog = createCatalogService(deps);
  const lifecycle = createLifecycleService({
    pool: deps.pool,
    clock: deps.clock,
    stock: deps.stock,
  });

  registerCatalogRoutes(app, { catalog, lifecycle });

  return { catalog, lifecycle };
}

export { createCatalogService } from './service.js';
export type { CatalogService, MerchandiseEligibility } from './service.js';

export { createLifecycleService } from './lifecycleService.js';
export type {
  LifecycleService,
  LifecycleServiceDeps,
  StockPresenceReader,
  VariantStockPresence,
} from './lifecycleService.js';

/**
 * Merchandise lifecycle policy, exported so the module that presents
 * merchandise can describe it without re-deriving it. The rules themselves stay
 * here: nothing outside this module decides what a status permits.
 */
export {
  effectiveLifecycle,
  merchandisePolicy,
  OPERATIONAL_LIFECYCLE_STATUSES,
} from './domain/lifecycle.js';
export type { MerchandisePolicy } from './domain/lifecycle.js';

/**
 * What a variant looks like to a module that is about to move stock against it,
 * and what the operational ones look like to a module that has to present them.
 * Re-exported here so the inventory module can name both types without reaching
 * into `infrastructure/`.
 */
export type {
  OperationalVariantListing,
  VariantLabel,
} from './infrastructure/catalogRepository.js';
