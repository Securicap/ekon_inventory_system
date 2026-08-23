import type { LifecycleStatus, Product, ProductVariant } from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError, conflict, notFound } from '../../platform/http/errors.js';
import {
  allowedTransitionsFrom,
  isTransitionAllowed,
  requiresZeroStock,
} from './domain/lifecycle.js';
import {
  getProductById,
  lockProductLifecycle,
  lockVariantIdsForProduct,
  lockVariantLifecycleForUpdate,
  updateProductLifecycle,
  updateVariantLifecycle,
} from './infrastructure/catalogRepository.js';

/**
 * Merchandise lifecycle control: `ACTIVE → DISCONTINUED → ARCHIVED`, and the
 * two corrective steps back.
 *
 * Kept apart from `CatalogService` deliberately, and narrowly. Creating
 * merchandise needs the clock, ids, and the whole merchandise vocabulary;
 * withdrawing it needs none of those and needs one thing creation must never
 * have — a way to ask the inventory module what is on the shelf. Folding the
 * two together would give the product-creation path a dependency on inventory
 * that it has no use for, and would be the first step towards a catalog service
 * that knows about balances.
 *
 * Two rules live here rather than in `domain/lifecycle.ts`, because both need
 * the database:
 *
 *  1. **archive safety** — merchandise holding stock cannot be archived;
 *  2. **the lock protocol** that makes rule 1 hold under concurrency.
 *
 * Everything else — which transitions exist, what each status permits, how a
 * product's status and a variant's combine — is pure policy and is stated once,
 * in the domain file.
 */

/** One variant's total on-hand quantity, summed across every location. */
export interface VariantStockPresence {
  variantId: string;
  quantityOnHand: number;
}

/**
 * What this service needs to know about stock, and nothing more.
 *
 * **A port, declared by the module that needs it.** `inventory_balances` belongs
 * to the inventory module, so the catalog does not query it — not from a
 * repository, not through a join, not "just for a count". It states the one
 * question it has, the composition root hands it inventory's implementation,
 * and neither module imports the other's tables. The mirror image of how
 * inventory asks the catalog whether a variant may be stocked.
 *
 * The method takes the caller's transaction client, because the answer has to
 * be read inside the same transaction that is about to archive — a stock check
 * on a separate connection would be answering about a different moment.
 */
export interface StockPresenceReader {
  /**
   * Which of these variants currently hold stock, and how much.
   *
   * **Bulk, and one statement**: archiving a product asks about all its variants
   * at once rather than one query per variant. Variants holding nothing are
   * absent from the result rather than returned as zeroes — the caller's
   * question is "which of these block the archive", and an empty answer is the
   * whole answer.
   */
  findVariantsHoldingStock(
    tx: DatabaseClient,
    variantIds: string[],
  ): Promise<VariantStockPresence[]>;
}

export interface LifecycleServiceDeps {
  pool: DatabasePool;
  /** Stamps `updated_at`. Never `new Date()`. */
  clock: Clock;
  /** Inventory's answer to what is on the shelf. See {@link StockPresenceReader}. */
  stock: StockPresenceReader;
}

export interface LifecycleService {
  /** Sets a product's lifecycle, returning the product as it now stands. */
  setProductLifecycle(productId: string, status: LifecycleStatus): Promise<Product>;
  /** Sets one variant's lifecycle, returning the variant as it now stands. */
  setVariantLifecycle(variantId: string, status: LifecycleStatus): Promise<ProductVariant>;
}

export function createLifecycleService(deps: LifecycleServiceDeps): LifecycleService {
  /**
   * Archiving a product is a statement about every variant beneath it: none of
   * them holds stock anywhere.
   *
   * The order inside the transaction is the whole design, and it is the same
   * order every posting workflow takes its locks in — `products`, then
   * `product_variants`, then the balances:
   *
   *  1. lock the product row `FOR UPDATE`;
   *  2. lock every variant row `FOR UPDATE`, in id order;
   *  3. only then read the balances.
   *
   * By step 3, any posting transaction that had already started against one of
   * these variants has committed or rolled back — it holds `FOR SHARE` on the
   * same rows, and this `FOR UPDATE` waited for it — so its stock is visible
   * and the archive is refused. Any posting transaction that starts *after*
   * step 1 blocks on those same rows until this one finishes, and then reads
   * `ARCHIVED` and refuses itself. Neither can slip past the other, and neither
   * needs a retry loop, an advisory lock, or an isolation level above
   * `READ COMMITTED`.
   *
   * A check-then-update without those locks would be exactly the race this
   * paragraph exists to rule out: archive reads zero, a receipt commits, archive
   * commits, and the shop has archived merchandise sitting on a shelf.
   */
  async function setProductLifecycle(productId: string, status: LifecycleStatus): Promise<Product> {
    return withTransaction(deps.pool, async (tx) => {
      const current = await lockProductLifecycle(tx, productId);
      if (current === null) throw notFound('Product');

      if (current !== status) {
        assertTransitionAllowed(current, status, 'product');

        if (requiresZeroStock(status)) {
          const variantIds = await lockVariantIdsForProduct(tx, productId);
          const holding = await deps.stock.findVariantsHoldingStock(tx, variantIds);
          if (holding.length > 0) throw archiveRefused(holding, 'product');
        }

        await updateProductLifecycle(tx, { id: productId, status, updatedAt: deps.clock.now() });
      }

      return loadProduct(tx, productId);
    });
  }

  /**
   * The variant counterpart. One row's status, one variant's stock.
   *
   * The transition is judged against the variant's **own** stored status rather
   * than its effective one. Withdrawing a colour of a product the shop still
   * sells is the ordinary case, and a variant under an already-archived product
   * is not thereby forbidden to record its own status — the effective rule
   * already governs what may be *done* with it, and rewriting stored rows to
   * agree with a derived answer is what this design deliberately avoids.
   *
   * Only the variant row is locked. A transaction holding it never asks for a
   * product lock afterwards, so there is no cycle to close against a concurrent
   * product-level change, which takes the product row first and the variant rows
   * second.
   */
  async function setVariantLifecycle(
    variantId: string,
    status: LifecycleStatus,
  ): Promise<ProductVariant> {
    return withTransaction(deps.pool, async (tx) => {
      const current = await lockVariantLifecycleForUpdate(tx, variantId);
      if (!current) throw notFound('Product variant');

      if (current.status !== status) {
        assertTransitionAllowed(current.status, status, 'variant');

        if (requiresZeroStock(status)) {
          const holding = await deps.stock.findVariantsHoldingStock(tx, [variantId]);
          if (holding.length > 0) throw archiveRefused(holding, 'variant');
        }

        await updateVariantLifecycle(tx, { id: variantId, status, updatedAt: deps.clock.now() });
      }

      const product = await loadProduct(tx, current.productId);
      const variant = product.variants.find((candidate) => candidate.id === variantId);
      // Unreachable: the variant was located and locked in this transaction, and
      // the loader reads every variant of its parent.
      if (!variant) {
        throw new AppError(
          'INTERNAL',
          `Variant ${variantId} vanished from product ${current.productId} within its own transaction`,
        );
      }
      return variant;
    });
  }

  return { setProductLifecycle, setVariantLifecycle };
}

/**
 * Reads the merchandise back through the ordinary product loader, inside the
 * same transaction.
 *
 * So a caller is told what was persisted rather than what was requested — the
 * same discipline `createProduct` follows, and the reason the response cannot
 * claim a status the database did not accept.
 */
async function loadProduct(tx: DatabaseClient, productId: string): Promise<Product> {
  const product = await getProductById(tx, productId);
  // Unreachable: the row was located and locked earlier in this transaction.
  if (!product) {
    throw new AppError('INTERNAL', `Product ${productId} vanished within its own transaction`);
  }
  return product;
}

/**
 * A refused transition is a `409`, and the message names what *is* allowed.
 *
 * Somebody pressing a button in a shop cannot read this file, but whoever they
 * telephone can read the log line, and "you may go to DISCONTINUED first" is
 * the difference between a support call and a database session. `ARCHIVED →
 * ACTIVE` is the one people meet: restoring archived merchandise is two
 * deliberate steps, because coming back into day-to-day operation and being
 * reordered again are two different decisions.
 */
function assertTransitionAllowed(
  from: LifecycleStatus,
  to: LifecycleStatus,
  what: 'product' | 'variant',
): void {
  if (isTransitionAllowed(from, to)) return;
  throw conflict(
    `This ${what} is ${from} and cannot become ${to}. ` +
      `Permitted from ${from}: ${allowedTransitionsFrom(from).join(', ')}.`,
  );
}

/**
 * Archiving merchandise that still holds stock is refused, and the refusal says
 * how much is where.
 *
 * A `409` rather than a `422`: the request is perfectly well formed, and it is
 * the state of the shelves that conflicts with it. The remedy is in the
 * message, because it is a real one — issue or adjust the remaining units, then
 * archive. Nothing here writes off stock to get the archive through, and the
 * lifecycle workflow will never post a movement on somebody's behalf: a status
 * change that quietly emptied a shelf would be the single most dangerous thing
 * in this system.
 */
function archiveRefused(holding: VariantStockPresence[], what: 'product' | 'variant'): AppError {
  const total = holding.reduce((sum, entry) => sum + entry.quantityOnHand, 0);
  const detail =
    what === 'product'
      ? `${holding.length} variant(s) still hold ${total} unit(s)`
      : `it still holds ${total} unit(s)`;
  return conflict(
    `This ${what} cannot be archived while it holds stock: ${detail}. ` +
      'Remove or adjust the remaining stock first — archiving does not write it off.',
  );
}
