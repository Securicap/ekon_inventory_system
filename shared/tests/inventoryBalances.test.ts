import { describe, expect, it } from 'vitest';
import {
  listInventoryBalancesResponseSchema,
  variantLocationBalanceSchema,
  variantStockBalanceSchema,
} from '../src/index.js';

/**
 * The current-stock contract, as both sides have to read it.
 *
 * Two things this file is really about. First, quantities: an inventory system
 * that accepts `-1` or `2.5` over the wire has already lost, whatever the
 * database says. Second, the difference between a zero with a timestamp and a
 * zero with `null` — a shelf drawn back down to zero, and a shelf that has never
 * held anything. Both are `quantity: 0`, and only `updatedAt` tells them apart.
 */

const validLocationBalance = {
  locationId: '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df78a',
  locationName: 'Main Store',
  isDefault: true,
  quantity: 12,
  updatedAt: '2026-08-03T12:00:00.000Z',
};

const validVariantStock = {
  variantId: '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df781',
  productId: '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df782',
  productName: 'Bottled Water',
  sku: 'EKN-A2B3C4D5',
  attributes: [{ name: 'size', value: '1L' }],
  totalQuantity: 12,
  locations: [validLocationBalance],
};

describe('a location balance', () => {
  it('accepts a well-formed entry', () => {
    expect(variantLocationBalanceSchema.safeParse(validLocationBalance).success).toBe(true);
  });

  it('accepts a null updatedAt — a shelf that has never held stock', () => {
    const neverStocked = { ...validLocationBalance, quantity: 0, updatedAt: null };
    expect(variantLocationBalanceSchema.safeParse(neverStocked).success).toBe(true);
  });

  it('accepts a zero quantity that still carries a timestamp', () => {
    // Stock that came and went. The row exists, so the moment it moved is real.
    const drawnToZero = { ...validLocationBalance, quantity: 0 };
    expect(variantLocationBalanceSchema.safeParse(drawnToZero).success).toBe(true);
  });

  it('rejects a negative quantity', () => {
    expect(
      variantLocationBalanceSchema.safeParse({ ...validLocationBalance, quantity: -1 }).success,
    ).toBe(false);
  });

  it('rejects a fractional quantity', () => {
    // A float quantity in an inventory system is an unfixable defect once
    // history exists — refused at the contract as well as at the column.
    expect(
      variantLocationBalanceSchema.safeParse({ ...validLocationBalance, quantity: 2.5 }).success,
    ).toBe(false);
  });

  it('rejects a non-uuid location id', () => {
    expect(
      variantLocationBalanceSchema.safeParse({ ...validLocationBalance, locationId: 'main-store' })
        .success,
    ).toBe(false);
  });

  it('rejects an updatedAt that is not a timestamp', () => {
    expect(
      variantLocationBalanceSchema.safeParse({ ...validLocationBalance, updatedAt: 'yesterday' })
        .success,
    ).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { isDefault: _omitted, ...withoutIsDefault } = validLocationBalance;
    expect(variantLocationBalanceSchema.safeParse(withoutIsDefault).success).toBe(false);
  });

  it('rejects a ledger field smuggled onto a shelf', () => {
    expect(
      variantLocationBalanceSchema.safeParse({
        ...validLocationBalance,
        lastMovementId: '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df783',
      }).success,
    ).toBe(false);
  });
});

describe('a variant stock entry', () => {
  it('accepts a well-formed entry', () => {
    expect(variantStockBalanceSchema.safeParse(validVariantStock).success).toBe(true);
  });

  it('accepts a variant with no attributes — the default variant', () => {
    expect(
      variantStockBalanceSchema.safeParse({ ...validVariantStock, attributes: [] }).success,
    ).toBe(true);
  });

  it('accepts a variant with no locations at all', () => {
    // The business has no active location. An operational problem for a screen
    // to surface, not a malformed response.
    expect(
      variantStockBalanceSchema.safeParse({
        ...validVariantStock,
        locations: [],
        totalQuantity: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects a SKU that is not in the shared format', () => {
    for (const sku of ['ABC-12345678', 'EKN-abcdefgh', 'EKN-123', '']) {
      expect(variantStockBalanceSchema.safeParse({ ...validVariantStock, sku }).success, sku).toBe(
        false,
      );
    }
  });

  it('rejects a non-uuid variant or product id', () => {
    expect(
      variantStockBalanceSchema.safeParse({ ...validVariantStock, variantId: 'not-a-uuid' })
        .success,
    ).toBe(false);
    expect(
      variantStockBalanceSchema.safeParse({ ...validVariantStock, productId: 'not-a-uuid' })
        .success,
    ).toBe(false);
  });

  it('rejects a negative or fractional total', () => {
    expect(
      variantStockBalanceSchema.safeParse({ ...validVariantStock, totalQuantity: -1 }).success,
    ).toBe(false);
    expect(
      variantStockBalanceSchema.safeParse({ ...validVariantStock, totalQuantity: 1.5 }).success,
    ).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { productName: _omitted, ...withoutProductName } = validVariantStock;
    expect(variantStockBalanceSchema.safeParse(withoutProductName).success).toBe(false);
  });

  it('rejects a malformed nested location entry', () => {
    expect(
      variantStockBalanceSchema.safeParse({
        ...validVariantStock,
        locations: [{ ...validLocationBalance, quantity: -4 }],
      }).success,
    ).toBe(false);
  });

  it('refuses every ledger and internal field, rather than ignoring it', () => {
    // This is a current-state view. A field that leaked here once would be
    // depended on, and this endpoint would quietly become movement history.
    for (const leaked of [
      'variantSignature',
      'lastMovementId',
      'movementId',
      'operationId',
      'userId',
      'requestHash',
      'quantityBefore',
      'quantityAfter',
    ]) {
      expect(
        variantStockBalanceSchema.safeParse({ ...validVariantStock, [leaked]: 'anything' }).success,
        leaked,
      ).toBe(false);
    }
  });
});

describe('the stock response', () => {
  it('treats an empty catalog as an empty array', () => {
    expect(listInventoryBalancesResponseSchema.parse([])).toEqual([]);
  });

  it('parses an array of variants', () => {
    const parsed = listInventoryBalancesResponseSchema.parse([
      validVariantStock,
      { ...validVariantStock, variantId: '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df784' },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it('rejects the whole response when one variant is malformed', () => {
    expect(
      listInventoryBalancesResponseSchema.safeParse([
        validVariantStock,
        { ...validVariantStock, totalQuantity: -2 },
      ]).success,
    ).toBe(false);
  });
});
