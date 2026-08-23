import {
  authenticatedUserSchema,
  variantStockBalanceSchema,
  type AuthenticatedUser,
  type Capability,
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
    sku?: string;
    lifecycleStatus?: 'ACTIVE' | 'DISCONTINUED' | 'ARCHIVED';
    variantLifecycleStatus?: 'ACTIVE' | 'DISCONTINUED' | 'ARCHIVED';
    attributes?: ReadonlyArray<{ name: string; value: string }>;
  } = {},
) {
  const id = overrides.id ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
  return {
    id,
    name: overrides.name ?? 'Diri',
    description: null,
    // What migrated merchandise looks like, and what the temporary product form
    // still creates: no brand, nothing classified, nothing priced. Every one of
    // these is a real state the API returns, not a placeholder.
    brand: null,
    classifications: [],
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
        sellingPrice: null,
        referenceCost: null,
        barcodes: [],
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
