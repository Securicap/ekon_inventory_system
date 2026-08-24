import type {
  InventoryMovementRecord,
  MovementHistoryPage,
  MovementHistoryQuery,
} from '@ekon/shared';
import type { DatabasePool } from '../../platform/db/pool.js';
import type { CatalogService, VariantLabel } from '../catalog/index.js';
import type { IdentityUserService } from '../identity/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './domain/historyCursor.js';
import {
  listMovementHistory,
  type LedgerEntry,
} from './infrastructure/movementHistoryRepository.js';
import { findLocationLabels, type LocationLabel } from './infrastructure/locationRepository.js';

/**
 * Stock history: the append-only ledger, read and labelled.
 *
 * The ledger already records the evidence — what changed, by how much, from
 * what to what, why, who, and when, twice. This service adds nothing to it. It
 * reads a bounded page, resolves the names for the permanent ids that page
 * refers to, and composes the two. There is no second history table, no
 * activity log, and no summary anywhere in it.
 *
 * **It writes nothing.** No transaction is opened, no lock is taken, no clock
 * is read, and no balance row is created — including for a shelf that has never
 * held stock, which a read has no business bringing into existence.
 *
 * **Labels are current, not historical.** The ledger stores ids; the product's
 * name, the brand, the location's name, and the person's display name are
 * resolved at read time from the tables that own them today. Renaming a product
 * changes what an old movement displays while the movement still refers to the
 * same immutable variant id and SKU. That is stated plainly in the shared
 * contract as well, because it is the one thing about this feed somebody could
 * reasonably misread.
 */
export interface MovementHistoryServiceDeps {
  pool: DatabasePool;
  /**
   * The catalog's application service, narrowed to the one question this
   * service asks it. Variants, SKUs, and merchandise names belong to the
   * catalog module, so a movement is labelled with a call rather than a join
   * across the boundary into `product_variants`.
   *
   * `findVariantLabels` and not `listStockableVariants`: the second filters to
   * merchandise that may be stocked today, and history that dropped a movement
   * because the shop has since retired the item would be hiding exactly the
   * record somebody went looking for.
   */
  catalog: Pick<CatalogService, 'findVariantLabels'>;
  /**
   * The identity module's user service, narrowed to a bulk display-name lookup.
   * Users belong to identity; this service never reads `users`, and what it can
   * ask for is a name and nothing else — no role, no status, no username.
   */
  identity: Pick<IdentityUserService, 'findUserDisplayNames'>;
}

export interface MovementHistoryService {
  listMovements(query: MovementHistoryQuery): Promise<MovementHistoryPage>;
}

export function createMovementHistoryService(
  deps: MovementHistoryServiceDeps,
): MovementHistoryService {
  /**
   * One page of history, newest recorded first.
   *
   * **Five bounded statements for a page of any size**, and one when the page is
   * empty: the movements, then the variant labels (two inside the catalog, for
   * the variants and their attributes), the location labels, and the display
   * names. The count is constant with respect to how many movements come back —
   * there is no query per row — because the ids are collected first and each
   * lookup is asked once, in bulk.
   *
   * The page is read as `limit + 1` rows. The extra row is never returned; it
   * is how the service knows whether there is another page without counting the
   * rest of the ledger, and it is what makes `nextCursor` null exactly on the
   * last page rather than one page late.
   */
  async function listMovements(query: MovementHistoryQuery): Promise<MovementHistoryPage> {
    const entries = await listMovementHistory(deps.pool, {
      variantId: query.variantId,
      locationId: query.locationId,
      movementType: query.movementType,
      recordedFrom: query.recordedFrom === undefined ? undefined : new Date(query.recordedFrom),
      recordedTo: query.recordedTo === undefined ? undefined : new Date(query.recordedTo),
      after: query.cursor === undefined ? undefined : decodeHistoryCursor(query.cursor),
      limit: query.limit + 1,
    });

    if (entries.length === 0) return { items: [], nextCursor: null };

    const hasMore = entries.length > query.limit;
    const page = hasMore ? entries.slice(0, query.limit) : entries;

    const [variants, locations, actors] = await Promise.all([
      deps.catalog.findVariantLabels(unique(page.map((entry) => entry.variantId))),
      findLocationLabels(deps.pool, unique(page.map((entry) => entry.locationId))),
      deps.identity.findUserDisplayNames(unique(page.map((entry) => entry.userId))),
    ]);

    const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
    const locationsById = new Map(locations.map((location) => [location.id, location]));
    const namesById = new Map(actors.map((actor) => [actor.id, actor.displayName]));

    const last = page[page.length - 1];

    return {
      items: page.map((entry) =>
        toRecord(entry, variantsById.get(entry.variantId), locationsById.get(entry.locationId), {
          displayName: namesById.get(entry.userId) ?? null,
        }),
      ),
      // Only on a page that has one, so a caller stops when the answer says to.
      nextCursor:
        hasMore && last
          ? encodeHistoryCursor({ recordedAt: last.recordedAtExact, id: last.id })
          : null,
    };
  }

  return { listMovements };
}

/**
 * A movement, labelled.
 *
 * The two `undefined` cases are the same shape of decision and both are
 * deliberate. A variant or a location that does not resolve is not an error
 * here: the movement is real, its ids are permanent ledger evidence, and the
 * record must stay readable. Neither can actually happen today — both columns
 * carry `ON DELETE RESTRICT` foreign keys, so the rows they point at cannot be
 * removed — which is why the fallback names the id rather than inventing a
 * plausible label. If it ever appears on a screen it is a defect to chase, not
 * a name to believe.
 */
function toRecord(
  entry: LedgerEntry,
  variant: VariantLabel | undefined,
  location: LocationLabel | undefined,
  actor: { displayName: string | null },
): InventoryMovementRecord {
  return {
    id: entry.id,
    movementType: entry.movementType,
    quantityDelta: entry.quantityDelta,
    quantityBefore: entry.quantityBefore,
    quantityAfter: entry.quantityAfter,
    reasonCode: entry.reasonCode,
    note: entry.note,
    occurredAt: entry.occurredAt.toISOString(),
    recordedAt: entry.recordedAt.toISOString(),
    operationId: entry.operationId,
    reversesMovementId: entry.reversesMovementId,
    reversedByMovementId: entry.reversedByMovementId,
    countId: entry.countId,
    variant: variant
      ? {
          id: variant.id,
          productId: variant.productId,
          productName: variant.productName,
          brandName: variant.brandName,
          sku: variant.sku,
          attributes: variant.attributes,
        }
      : unresolvedVariant(entry.variantId),
    location: location ?? { id: entry.locationId, name: UNRESOLVED },
    actor: { id: entry.userId, displayName: actor.displayName },
  };
}

/**
 * What is shown when a permanent id names nothing. Not a blank and not a
 * guess — a label that says so, so nobody reads it as merchandise.
 */
const UNRESOLVED = 'Unknown';

function unresolvedVariant(variantId: string): InventoryMovementRecord['variant'] {
  return {
    id: variantId,
    productId: variantId,
    productName: UNRESOLVED,
    brandName: null,
    // The SKU is `NOT NULL` on every variant and the contract requires the
    // format, so there is nothing honest to put here but the shape itself.
    sku: 'EKN-00000000',
    attributes: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
