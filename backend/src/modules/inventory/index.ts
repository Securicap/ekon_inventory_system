import type { FastifyInstance } from 'fastify';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import type { CatalogService } from '../catalog/index.js';
import type { IdentityUserService } from '../identity/index.js';
import { createAdjustmentService, type AdjustmentService } from './adjustmentService.js';
import { createLedgerService, type LedgerService } from './ledgerService.js';
import {
  createMovementHistoryService,
  type MovementHistoryService,
} from './movementHistoryService.js';
import { createReceivingService, type ReceivingService } from './receivingService.js';
import { createRemovalService, type RemovalService } from './removalService.js';
import { createReversalService, type ReversalService } from './reversalService.js';
import { registerInventoryRoutes } from './routes.js';
import { createInventoryService, type InventoryService } from './service.js';

/**
 * The inventory module's composition entry point. The application root calls
 * this; nothing reaches into the module's `domain/` or `infrastructure/`
 * internals.
 *
 * The posting engine is built here and still has **no HTTP surface of its
 * own** — no route, no request schema, no handler. Four workflows call it, and
 * each calls it the same way: describe the business event, let the engine own
 * the movement. Physical counts are PR 6 and are the fifth.
 *
 * The catalog service is a dependency rather than a set of tables: variants
 * belong to the catalog module, so each workflow asks it the question named
 * after what that workflow is about to do — may this be received into, issued
 * from, or corrected — instead of reaching across the boundary into
 * `product_variants`, and the stock read asks it which merchandise is still
 * operational instead of joining to `products`.
 *
 * The identity user service arrives the same way and for the same reason. Stock
 * history records who posted each movement, and a screen showing one has to be
 * able to say who — so the name is asked for, in bulk, through identity's own
 * service. `users` is not this module's table and nothing here reads it.
 */
export function registerInventory(
  app: FastifyInstance,
  deps: {
    pool: DatabasePool;
    clock: Clock;
    catalog: CatalogService;
    identity: Pick<IdentityUserService, 'findUserDisplayNames'>;
  },
): {
  inventory: InventoryService;
  history: MovementHistoryService;
  ledger: LedgerService;
  receiving: ReceivingService;
  removal: RemovalService;
  adjustment: AdjustmentService;
  reversal: ReversalService;
} {
  const inventory = createInventoryService({ pool: deps.pool, catalog: deps.catalog });
  const history = createMovementHistoryService({
    pool: deps.pool,
    catalog: deps.catalog,
    identity: deps.identity,
  });
  const ledger = createLedgerService({ pool: deps.pool, clock: deps.clock });
  const receiving = createReceivingService({ pool: deps.pool, ledger, catalog: deps.catalog });
  const removal = createRemovalService({ pool: deps.pool, ledger, catalog: deps.catalog });
  const adjustment = createAdjustmentService({ pool: deps.pool, ledger, catalog: deps.catalog });
  const reversal = createReversalService({ ledger, catalog: deps.catalog });

  registerInventoryRoutes(app, {
    inventory,
    history,
    receiving,
    removal,
    adjustment,
    reversal,
  });

  return { inventory, history, ledger, receiving, removal, adjustment, reversal };
}

export { createInventoryService } from './service.js';
export type { InventoryService, InventoryServiceDeps } from './service.js';

export { createMovementHistoryService } from './movementHistoryService.js';
export type {
  MovementHistoryService,
  MovementHistoryServiceDeps,
} from './movementHistoryService.js';

export { createLedgerService } from './ledgerService.js';
export type {
  LedgerService,
  LedgerServiceDeps,
  MovementPrecondition,
  OperationClaim,
  PostableMovementType,
  PostMovementCommand,
  PostReversalCommand,
} from './ledgerService.js';
export type { PostedMovement } from './infrastructure/ledgerRepository.js';

export { createReceivingService } from './receivingService.js';
export type {
  ReceiveStockCommand,
  ReceivingService,
  ReceivingServiceDeps,
} from './receivingService.js';

export { createRemovalService } from './removalService.js';
export type { RemovalService, RemovalServiceDeps, RemoveStockCommand } from './removalService.js';

export { createAdjustmentService } from './adjustmentService.js';
export type {
  AdjustmentService,
  AdjustmentServiceDeps,
  AdjustStockCommand,
} from './adjustmentService.js';

export { createReversalService } from './reversalService.js';
export type {
  ReversalService,
  ReversalServiceDeps,
  ReverseMovementCommand,
} from './reversalService.js';

/**
 * Whether merchandise currently holds stock — the inventory module's answer to
 * the one question the catalog's archive check has to ask it.
 *
 * Exported as a standalone factory rather than as part of `registerInventory`
 * because the composition root needs it *before* the catalog exists, and the
 * catalog exists before this module does. It depends on nothing: no pool, no
 * clock, no service. See `stockPresenceService.ts` for why the boundary runs
 * this way round.
 */
export { createStockPresenceService } from './stockPresenceService.js';
export type { StockPresenceService } from './stockPresenceService.js';
export type { VariantStockTotal } from './infrastructure/balanceRepository.js';

/** The `operations.operation_type` a receiving command claims its id under. */
export { RECEIVING_OPERATION_TYPE } from './domain/receivingRequestHash.js';

/** The `operations.operation_type` a removal command claims its id under. */
export { REMOVAL_OPERATION_TYPE } from './domain/removalRequestHash.js';

/** The `operations.operation_type` an adjustment command claims its id under. */
export { ADJUSTMENT_OPERATION_TYPE } from './domain/adjustmentRequestHash.js';

/** The `operations.operation_type` a reversal command claims its id under. */
export { REVERSAL_OPERATION_TYPE } from './domain/reversalRequestHash.js';
