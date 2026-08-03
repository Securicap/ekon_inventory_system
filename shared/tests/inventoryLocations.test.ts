import { describe, expect, it } from 'vitest';
import { inventoryLocationSchema, listInventoryLocationsResponseSchema } from '../src/index.js';

const validLocation = {
  id: '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df78a',
  name: 'Main Store',
  isDefault: true,
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('inventory location contract', () => {
  it('accepts a well-formed location', () => {
    expect(inventoryLocationSchema.safeParse(validLocation).success).toBe(true);
  });

  it('rejects a non-uuid id', () => {
    expect(inventoryLocationSchema.safeParse({ ...validLocation, id: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it('rejects a non-boolean isDefault', () => {
    expect(inventoryLocationSchema.safeParse({ ...validLocation, isDefault: 'true' }).success).toBe(
      false,
    );
  });

  it('rejects a non-datetime createdAt', () => {
    expect(
      inventoryLocationSchema.safeParse({ ...validLocation, createdAt: 'yesterday' }).success,
    ).toBe(false);
  });

  it('treats an empty location list as an empty array', () => {
    expect(listInventoryLocationsResponseSchema.parse([])).toEqual([]);
  });

  it('parses an array of locations', () => {
    const parsed = listInventoryLocationsResponseSchema.parse([
      validLocation,
      { ...validLocation, id: '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df78b', isDefault: false },
    ]);
    expect(parsed).toHaveLength(2);
  });
});
