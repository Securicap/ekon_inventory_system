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

export function productFixture(overrides: { id?: string; name?: string; sku?: string } = {}) {
  const id = overrides.id ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
  return {
    id,
    name: overrides.name ?? 'Diri',
    description: null,
    isActive: true,
    variants: [
      {
        id: `${id.slice(0, -2)}v1`,
        productId: id,
        sku: overrides.sku ?? 'EKN-AB12CD34',
        variantSignature: 'signature',
        isActive: true,
        attributes: [],
        createdAt: '2026-08-02T12:00:00.000Z',
        updatedAt: '2026-08-02T12:00:00.000Z',
      },
    ],
    createdAt: '2026-08-02T12:00:00.000Z',
    updatedAt: '2026-08-02T12:00:00.000Z',
  };
}

export function locationFixture(overrides: { name?: string; isDefault?: boolean } = {}) {
  return {
    id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01',
    name: overrides.name ?? 'Main Store',
    isDefault: overrides.isDefault ?? true,
    isActive: true,
    createdAt: '2026-08-02T12:00:00.000Z',
    updatedAt: '2026-08-02T12:00:00.000Z',
  };
}
