import {
  authenticatedUserSchema,
  countRecordSchema,
  inventoryMovementRecordSchema,
  variantStockBalanceSchema,
  type AuthenticatedUser,
  type Capability,
  type CountReconciliationReason,
  type CountRecord,
  type InventoryMovementRecord,
  type VariantStockBalance,
} from '@ekon/shared';

/**
 * The safe user shape `/api/auth/me` and a successful login both return.
 *
 * Built through the shared schema, so a fixture that drifts from the contract
 * fails in the fixture rather than in the test that used it — and so no test
 * can accidentally assert against a user the server could never send. The
 * schema also refuses unsorted or duplicated capabilities, which is why they
 * are sorted here rather than written out in the right order by hand.
 */
export function userFixture(
  overrides: Partial<Omit<AuthenticatedUser, 'capabilities'>> & {
    capabilities?: readonly Capability[];
  } = {},
): AuthenticatedUser {
  const { capabilities = ['catalog.read', 'inventory.read'], ...rest } = overrides;

  return authenticatedUserSchema.parse({
    id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    username: 'marie.j',
    displayName: 'Marie Joseph',
    role: 'OWNER',
    ...rest,
    capabilities: [...new Set(capabilities)].sort(),
  });
}

/** The body shape of `GET /api/auth/me` and of a successful login. */
export function userResponse(user: AuthenticatedUser = userFixture()): { user: AuthenticatedUser } {
  return { user };
}

/**
 * One product with one variant, as `GET /api/catalog/products` returns it.
 *
 * `lifecycleStatus` on both the product and the variant is overridable because
 * receiving has to refuse each of them separately: a withdrawn line and a
 * withdrawn size are different facts, and neither may take new stock. It is the
 * only availability flag there is — `isActive` was the temporary bridge, and
 * 0012 removed it from the wire along with the column behind it.
 */
export function productFixture(
  overrides: {
    id?: string;
    name?: string;
    description?: string | null;
    sku?: string;
    lifecycleStatus?: 'ACTIVE' | 'DISCONTINUED' | 'ARCHIVED';
    variantLifecycleStatus?: 'ACTIVE' | 'DISCONTINUED' | 'ARCHIVED';
    attributes?: ReadonlyArray<{ name: string; value: string }>;
    /** Structured merchandise: a brand is a row, not words in a name. */
    brand?: { id: string; name: string } | null;
    classifications?: ReadonlyArray<{ dimension: string; dimensionName: string; value: string }>;
    sellingPrice?: { amountMinor: number; currency: string } | null;
    referenceCost?: { amountMinor: number; currency: string } | null;
    barcodes?: readonly string[];
  } = {},
) {
  const id = overrides.id ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
  return {
    id,
    name: overrides.name ?? 'Diri',
    description: overrides.description ?? null,
    // Merchandise nobody has completed yet: no brand, nothing classified,
    // nothing priced. Every one of these is a real state the API returns rather
    // than a placeholder, and it is what a migrated catalog looks like.
    brand: overrides.brand ?? null,
    classifications: overrides.classifications ? [...overrides.classifications] : [],
    lifecycleStatus: overrides.lifecycleStatus ?? ('ACTIVE' as const),
    variants: [
      {
        // A real uuid, not the product's id with a marker appended: receiving
        // parses ids with the shared schema before sending them, so a fixture
        // that is not one would fail for a reason no screen could have.
        id: `${id.slice(0, -2)}f1`,
        productId: id,
        sku: overrides.sku ?? 'EKN-AB12CD34',
        attributes: overrides.attributes ? [...overrides.attributes] : [],
        sellingPrice: overrides.sellingPrice ?? null,
        referenceCost: overrides.referenceCost ?? null,
        barcodes: overrides.barcodes ? [...overrides.barcodes] : [],
        lifecycleStatus: overrides.variantLifecycleStatus ?? ('ACTIVE' as const),
        createdAt: '2026-08-02T12:00:00.000Z',
        updatedAt: '2026-08-02T12:00:00.000Z',
      },
    ],
    createdAt: '2026-08-02T12:00:00.000Z',
    updatedAt: '2026-08-02T12:00:00.000Z',
  };
}

/** The id of the single variant a `productFixture` carries. */
export function variantIdOf(product: ReturnType<typeof productFixture>): string {
  return product.variants[0]!.id;
}

export function locationFixture(
  overrides: { id?: string; name?: string; isDefault?: boolean; isActive?: boolean } = {},
) {
  return {
    id: overrides.id ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01',
    name: overrides.name ?? 'Main Store',
    isDefault: overrides.isDefault ?? true,
    isActive: overrides.isActive ?? true,
    createdAt: '2026-08-02T12:00:00.000Z',
    updatedAt: '2026-08-02T12:00:00.000Z',
  };
}

/** One location's line inside a balance fixture, as a test wants to say it. */
interface BalanceLocationOverrides {
  locationId?: string;
  locationName?: string;
  isDefault?: boolean;
  quantity?: number;
  /** Explicitly `null` for a shelf that has never held stock. */
  updatedAt?: string | null;
}

/**
 * One variant of `GET /api/inventory/balances`: what it is, and what it holds
 * at each active location.
 *
 * Built through the shared response schema, like `userFixture`, so a fixture
 * that drifts from the contract fails here rather than in the test that used
 * it — and so no test can assert against a response the server could not send.
 * The schema is `.strict()`, which is what stops a test from "helpfully"
 * adding a movement id to a fixture and proving the screen hides something the
 * API never sends.
 *
 * `totalQuantity` is summed from the locations unless a test says otherwise.
 * The backend guarantees the two agree, so every ordinary fixture leaves it
 * alone — the one reason to set it is to prove that the screen *shows the
 * server's total* rather than quietly re-adding the location quantities
 * itself. The schema permits the two to differ (it validates each number, not
 * the arithmetic between them), which is exactly why a screen that recomputed
 * would go unnoticed without a fixture that can tell the two apart.
 *
 * Defaults to one location, `Main Store`, holding nothing and never stocked —
 * the state of a fresh install.
 */
export function balanceFixture(
  overrides: {
    variantId?: string;
    productId?: string;
    productName?: string;
    sku?: string;
    attributes?: ReadonlyArray<{ name: string; value: string }>;
    locations?: readonly BalanceLocationOverrides[];
    /** Only ever set by a test about where the total comes from. */
    totalQuantity?: number;
  } = {},
): VariantStockBalance {
  const productId = overrides.productId ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';

  const locations = (overrides.locations ?? [{}]).map((location, index) => {
    const quantity = location.quantity ?? 0;
    return {
      locationId: location.locationId ?? `0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b0${index + 1}`,
      locationName: location.locationName ?? (index === 0 ? 'Main Store' : `Location ${index + 1}`),
      isDefault: location.isDefault ?? index === 0,
      quantity,
      // A shelf that has held stock has a timestamp; one that never has, has
      // `null`. A test says so explicitly when it is the point of the test.
      updatedAt:
        location.updatedAt !== undefined
          ? location.updatedAt
          : quantity > 0
            ? '2026-08-05T09:15:00.000Z'
            : null,
    };
  });

  return variantStockBalanceSchema.parse({
    variantId: overrides.variantId ?? `${productId.slice(0, -2)}f${productId.slice(-1)}`,
    productId,
    productName: overrides.productName ?? 'Diri',
    sku: overrides.sku ?? 'EKN-AB12CD34',
    attributes: overrides.attributes ? [...overrides.attributes] : [],
    totalQuantity:
      overrides.totalQuantity ??
      locations.reduce((total, location) => total + location.quantity, 0),
    locations,
  });
}

/**
 * What `GET /api/catalog/metadata` answers: the catalog's own vocabulary.
 *
 * The product form is built from this, so a fixture that drifts from it would
 * be testing a form nobody can fill in. The attribute names in particular are
 * the ones 0010 seeds — a shop cannot invent one, and neither can a test.
 */
export function metadataFixture(
  overrides: {
    brands?: ReadonlyArray<{ id: string; name: string }>;
    classificationDimensions?: ReadonlyArray<{
      key: string;
      name: string;
      values: ReadonlyArray<{ id: string; value: string }>;
    }>;
    variantAttributeDefinitions?: ReadonlyArray<{ id: string; name: string }>;
  } = {},
) {
  return {
    brands: overrides.brands
      ? [...overrides.brands]
      : [{ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01', name: 'Steve Madden' }],
    classificationDimensions: overrides.classificationDimensions
      ? overrides.classificationDimensions.map((dimension) => ({
          ...dimension,
          values: [...dimension.values],
        }))
      : [
          {
            key: 'audience',
            name: 'Audience',
            values: [{ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01', value: 'Fanm' }],
          },
          {
            key: 'category',
            name: 'Category',
            values: [{ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c02', value: 'Soulye' }],
          },
        ],
    variantAttributeDefinitions: overrides.variantAttributeDefinitions
      ? [...overrides.variantAttributeDefinitions]
      : [
          { id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d01', name: 'color' },
          { id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d02', name: 'size' },
          { id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d03', name: 'width' },
        ],
  };
}

/**
 * The merchandise label a movement and a count both carry.
 *
 * One shape, shared by both feeds, because it is one shape in the contract —
 * a count and a movement label the same item, and two fixtures for it would be
 * two things to keep in step.
 */
function movementVariant(
  overrides: {
    variantId?: string;
    productId?: string;
    productName?: string;
    brandName?: string | null;
    sku?: string;
    attributes?: ReadonlyArray<{ name: string; value: string }>;
  } = {},
) {
  const productId = overrides.productId ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
  return {
    id: overrides.variantId ?? `${productId.slice(0, -2)}f1`,
    productId,
    productName: overrides.productName ?? 'Diri',
    brandName: overrides.brandName ?? null,
    sku: overrides.sku ?? 'EKN-AB12CD34',
    attributes: overrides.attributes ? [...overrides.attributes] : [],
  };
}

/**
 * One movement, as `GET /api/inventory/movements` returns it.
 *
 * `quantityBefore` and `quantityAfter` are computed from the delta unless a
 * test says otherwise, because the ledger guarantees they agree (INV-3) and a
 * fixture that disagreed would be proving a screen against a row the server
 * could not have written. Built through the shared schema for the same reason
 * every other fixture here is.
 */
export function movementFixture(
  overrides: {
    id?: string;
    movementType?: 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT' | 'REVERSAL' | 'COUNT_RECONCILIATION';
    quantityDelta?: number;
    quantityBefore?: number;
    reasonCode?: string | null;
    note?: string | null;
    occurredAt?: string;
    recordedAt?: string;
    operationId?: string;
    reversesMovementId?: string | null;
    countId?: string | null;
    reversedByMovementId?: string | null;
    actorName?: string | null;
    locationId?: string;
    locationName?: string;
    variant?: Parameters<typeof movementVariant>[0];
  } = {},
): InventoryMovementRecord {
  const quantityDelta = overrides.quantityDelta ?? 10;
  const quantityBefore = overrides.quantityBefore ?? 0;

  return inventoryMovementRecordSchema.parse({
    id: overrides.id ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01',
    movementType: overrides.movementType ?? 'RECEIPT',
    quantityDelta,
    quantityBefore,
    quantityAfter: quantityBefore + quantityDelta,
    reasonCode: overrides.reasonCode ?? null,
    note: overrides.note ?? null,
    occurredAt: overrides.occurredAt ?? '2026-08-05T09:15:00.000Z',
    recordedAt: overrides.recordedAt ?? '2026-08-05T09:16:00.000Z',
    operationId: overrides.operationId ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4901',
    reversesMovementId: overrides.reversesMovementId ?? null,
    countId: overrides.countId ?? null,
    reversedByMovementId: overrides.reversedByMovementId ?? null,
    variant: movementVariant(overrides.variant),
    location: {
      id: overrides.locationId ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01',
      name: overrides.locationName ?? 'Main Store',
    },
    actor: {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      displayName: overrides.actorName === undefined ? 'Marie Joseph' : overrides.actorName,
    },
  });
}

/**
 * One count observation, as `GET /api/inventory/counts` returns it.
 *
 * The variance is `counted − expected`, computed here for the same reason the
 * movement's arithmetic is: the server stores all three permanently and they
 * agree by construction. A fixture that let them disagree would be evidence
 * about nothing.
 *
 * `status` follows from the variance and the reconciliation unless a test
 * overrides it — a match is `MATCHED`, an unexplained difference is `OPEN`, and
 * a settled one is `RECONCILED`.
 */
export function countFixture(
  overrides: {
    id?: string;
    expectedQuantity?: number;
    countedQuantity?: number;
    countedAt?: string;
    recordedAt?: string;
    status?: 'MATCHED' | 'OPEN' | 'RECONCILED';
    counterName?: string | null;
    locationId?: string;
    locationName?: string;
    variant?: Parameters<typeof movementVariant>[0];
    reconciliation?: {
      reason?: CountReconciliationReason;
      note?: string | null;
      actorName?: string | null;
    } | null;
  } = {},
): CountRecord {
  const expectedQuantity = overrides.expectedQuantity ?? 7;
  const countedQuantity = overrides.countedQuantity ?? 6;
  const variance = countedQuantity - expectedQuantity;
  const reconciliation = overrides.reconciliation ?? null;

  return countRecordSchema.parse({
    id: overrides.id ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c11',
    variant: movementVariant(overrides.variant),
    location: {
      id: overrides.locationId ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01',
      name: overrides.locationName ?? 'Main Store',
    },
    expectedQuantity,
    countedQuantity,
    variance,
    countedAt: overrides.countedAt ?? '2026-08-05T09:15:00.000Z',
    recordedAt: overrides.recordedAt ?? '2026-08-05T09:16:00.000Z',
    counter: {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      displayName: overrides.counterName === undefined ? 'Marie Joseph' : overrides.counterName,
    },
    status:
      overrides.status ??
      (reconciliation !== null ? 'RECONCILED' : variance === 0 ? 'MATCHED' : 'OPEN'),
    reconciliation:
      reconciliation === null
        ? null
        : {
            reason: reconciliation.reason ?? 'UNRECORDED_SALE',
            note: reconciliation.note ?? null,
            reconciledAt: '2026-08-05T11:00:00.000Z',
            actor: {
              id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
              displayName:
                reconciliation.actorName === undefined ? 'Jean Baptiste' : reconciliation.actorName,
            },
            movementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e77',
          },
  });
}

/** One page of either feed. `nextCursor` is `null` unless there is more. */
export function page<T>(items: readonly T[], nextCursor: string | null = null) {
  return { items: [...items], nextCursor };
}
