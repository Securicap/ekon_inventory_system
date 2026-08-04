import { authenticatedUserSchema, type AuthenticatedUser, type Capability } from '@ekon/shared';

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
 * `isActive` on both the product and the variant is overridable because
 * receiving has to refuse each of them separately: a retired product and a
 * discontinued size are different facts, and neither may take new stock.
 */
export function productFixture(
  overrides: {
    id?: string;
    name?: string;
    sku?: string;
    isActive?: boolean;
    variantIsActive?: boolean;
    attributes?: ReadonlyArray<{ name: string; value: string }>;
  } = {},
) {
  const id = overrides.id ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
  return {
    id,
    name: overrides.name ?? 'Diri',
    description: null,
    isActive: overrides.isActive ?? true,
    variants: [
      {
        // A real uuid, not the product's id with a marker appended: receiving
        // parses ids with the shared schema before sending them, so a fixture
        // that is not one would fail for a reason no screen could have.
        id: `${id.slice(0, -2)}f1`,
        productId: id,
        sku: overrides.sku ?? 'EKN-AB12CD34',
        variantSignature: 'signature',
        isActive: overrides.variantIsActive ?? true,
        attributes: overrides.attributes ? [...overrides.attributes] : [],
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
