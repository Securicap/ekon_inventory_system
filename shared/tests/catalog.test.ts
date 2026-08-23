import { describe, expect, it } from 'vitest';
import {
  createProductRequestSchema,
  listProductsResponseSchema,
  moneySchema,
  productSchema,
  productVariantSchema,
  SKU_PATTERN,
} from '../src/index.js';

/** A variant response with every field settled, for tests that vary one of them. */
const VARIANT = {
  id: '00000000-0000-7000-8000-000000000000',
  productId: '00000000-0000-7000-8000-000000000001',
  sku: 'EKN-ABCDEFGH',
  attributes: [],
  sellingPrice: null,
  referenceCost: null,
  barcodes: [],
  lifecycleStatus: 'ACTIVE',
  isActive: true,
  createdAt: '2026-08-03T12:00:00.000Z',
  updatedAt: '2026-08-03T12:00:00.000Z',
};

const PRODUCT = {
  id: '00000000-0000-7000-8000-000000000001',
  name: 'Bel Ami',
  description: null,
  brand: null,
  classifications: [],
  lifecycleStatus: 'ACTIVE',
  isActive: true,
  variants: [VARIANT],
  createdAt: '2026-08-03T12:00:00.000Z',
  updatedAt: '2026-08-03T12:00:00.000Z',
};

describe('create-product request contract', () => {
  it('accepts a product with one default variant', () => {
    const parsed = createProductRequestSchema.safeParse({
      name: 'Bottled Water',
      variants: [{ attributes: {} }],
    });
    expect(parsed.success).toBe(true);
  });

  it('trims the name and requires it to be non-empty', () => {
    expect(createProductRequestSchema.safeParse({ name: '   ', variants: [{}] }).success).toBe(
      false,
    );
    const ok = createProductRequestSchema.parse({ name: '  Shoe  ', variants: [{}] });
    expect(ok.name).toBe('Shoe');
  });

  it('requires at least one variant', () => {
    expect(createProductRequestSchema.safeParse({ name: 'X', variants: [] }).success).toBe(false);
  });

  it('refuses a client-supplied SKU', () => {
    const parsed = createProductRequestSchema.safeParse({
      name: 'X',
      variants: [{ attributes: {}, sku: 'EKN-AAAAAAAA' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults a variant with no attributes to an empty attribute set', () => {
    const parsed = createProductRequestSchema.parse({ name: 'X', variants: [{}] });
    expect(parsed.variants[0]?.attributes).toEqual({});
  });
});

describe('create-product merchandise contract', () => {
  it('accepts a brand as a name, not as an id', () => {
    // The person entering merchandise knows "Steve Madden" and could not know a
    // uuid. The service resolves it case-insensitively and creates it only if
    // it is genuinely new.
    const parsed = createProductRequestSchema.parse({
      name: 'Bel Ami',
      brand: '  Steve Madden  ',
      variants: [{}],
    });
    expect(parsed.brand).toBe('Steve Madden');
  });

  it('refuses a blank brand rather than treating it as absent', () => {
    expect(
      createProductRequestSchema.safeParse({ name: 'X', brand: '   ', variants: [{}] }).success,
    ).toBe(false);
  });

  it('lets merchandise carry no brand at all', () => {
    expect(createProductRequestSchema.parse({ name: 'X', variants: [{}] }).brand).toBeUndefined();
    expect(
      createProductRequestSchema.safeParse({ name: 'X', brand: null, variants: [{}] }).success,
    ).toBe(true);
  });

  it('keys classifications by dimension, so a product cannot be filed twice under one', () => {
    const parsed = createProductRequestSchema.parse({
      name: 'Bel Ami',
      classifications: { audience: 'Women', category: '  Footwear  ' },
      variants: [{}],
    });
    expect(parsed.classifications).toEqual({ audience: 'Women', category: 'Footwear' });
  });

  it('defaults an unclassified product to no classifications', () => {
    expect(createProductRequestSchema.parse({ name: 'X', variants: [{}] }).classifications).toEqual(
      {},
    );
  });

  it('refuses a dimension key that is not one', () => {
    for (const key of ['Category', 'sub category', '1st']) {
      expect(
        createProductRequestSchema.safeParse({
          name: 'X',
          classifications: { [key]: 'Footwear' },
          variants: [{}],
        }).success,
      ).toBe(false);
    }
  });

  it('refuses a blank classification value', () => {
    expect(
      createProductRequestSchema.safeParse({
        name: 'X',
        classifications: { category: '   ' },
        variants: [{}],
      }).success,
    ).toBe(false);
  });

  it('accepts a price and a cost in different currencies', () => {
    const parsed = createProductRequestSchema.parse({
      name: 'Bel Ami',
      variants: [
        {
          attributes: { color: 'Black' },
          sellingPrice: { amountMinor: 249900, currency: 'HTG' },
          referenceCost: { amountMinor: 1800, currency: 'USD' },
        },
      ],
    });
    expect(parsed.variants[0]?.sellingPrice?.currency).toBe('HTG');
    expect(parsed.variants[0]?.referenceCost?.currency).toBe('USD');
  });

  it('lets a variant be unpriced', () => {
    const parsed = createProductRequestSchema.parse({ name: 'X', variants: [{}] });
    expect(parsed.variants[0]?.sellingPrice).toBeUndefined();
    expect(
      createProductRequestSchema.safeParse({ name: 'X', variants: [{ sellingPrice: null }] })
        .success,
    ).toBe(true);
  });

  it('refuses a negative or fractional price at the contract', () => {
    for (const amountMinor of [-1, 24.99]) {
      expect(
        createProductRequestSchema.safeParse({
          name: 'X',
          variants: [{ sellingPrice: { amountMinor, currency: 'HTG' } }],
        }).success,
      ).toBe(false);
    }
  });

  it('accepts barcodes, and defaults to none', () => {
    const parsed = createProductRequestSchema.parse({
      name: 'X',
      variants: [{ barcodes: ['0885140123456', 'DIST-99A'] }],
    });
    expect(parsed.variants[0]?.barcodes).toEqual(['0885140123456', 'DIST-99A']);
    expect(
      createProductRequestSchema.parse({ name: 'X', variants: [{}] }).variants[0]?.barcodes,
    ).toEqual([]);
  });

  it('refuses a blank, over-long, or whitespace-bearing barcode', () => {
    for (const barcode of ['', ' 0885 ', '0885 140', 'X'.repeat(65)]) {
      expect(
        createProductRequestSchema.safeParse({ name: 'X', variants: [{ barcodes: [barcode] }] })
          .success,
      ).toBe(false);
    }
  });

  it('refuses the same barcode listed twice on one variant', () => {
    expect(
      createProductRequestSchema.safeParse({
        name: 'X',
        variants: [{ barcodes: ['0885140123456', '0885140123456'] }],
      }).success,
    ).toBe(false);
  });

  it('refuses every field the server owns', () => {
    // `.strict()` is what makes this exhaustive: none of these can be smuggled
    // in, and a new server-owned field is refused without anybody listing it.
    for (const field of [
      { id: '00000000-0000-7000-8000-000000000000' },
      { lifecycleStatus: 'ARCHIVED' },
      { isActive: false },
      { createdAt: '2026-08-03T12:00:00.000Z' },
      { updatedAt: '2026-08-03T12:00:00.000Z' },
    ]) {
      expect(
        createProductRequestSchema.safeParse({ name: 'X', variants: [{}], ...field }).success,
      ).toBe(false);
    }

    for (const field of [
      { id: '00000000-0000-7000-8000-000000000000' },
      { sku: 'EKN-AAAAAAAA' },
      { variantSignature: '[]' },
      { lifecycleStatus: 'ARCHIVED' },
      { isActive: false },
      { createdAt: '2026-08-03T12:00:00.000Z' },
    ]) {
      expect(
        createProductRequestSchema.safeParse({ name: 'X', variants: [{ ...field }] }).success,
      ).toBe(false);
    }
  });
});

describe('catalog response contract', () => {
  it('validates SKUs against the shared format', () => {
    expect(SKU_PATTERN.test('EKN-ABCDEFGH')).toBe(true);
    expect(SKU_PATTERN.test('EKN-lowercase')).toBe(false);
    expect(SKU_PATTERN.test('SKU-ABCDEFGH')).toBe(false);
    expect(productVariantSchema.safeParse({ ...VARIANT, sku: 'not-a-sku' }).success).toBe(false);
  });

  it('treats an empty catalog as an empty array', () => {
    expect(listProductsResponseSchema.parse([])).toEqual([]);
  });

  it('accepts merchandise nobody has completed yet', () => {
    // What migration 0009 left behind: no brand, nothing classified, nothing
    // priced. Every one of those is a state the API really returns, so a
    // contract that could not express them would make the list endpoint fail on
    // exactly the products the shop already has.
    const product = productSchema.parse(PRODUCT);
    expect(product.brand).toBeNull();
    expect(product.classifications).toEqual([]);
    expect(product.variants[0]?.sellingPrice).toBeNull();
    expect(product.variants[0]?.referenceCost).toBeNull();
    expect(product.variants[0]?.barcodes).toEqual([]);
  });

  it('accepts merchandise with the whole model filled in', () => {
    const product = productSchema.parse({
      ...PRODUCT,
      brand: { id: '00000000-0000-7000-8000-00000000000b', name: 'Steve Madden' },
      classifications: [{ dimension: 'category', dimensionName: 'Category', value: 'Footwear' }],
      variants: [
        {
          ...VARIANT,
          attributes: [{ name: 'color', value: 'Black' }],
          sellingPrice: { amountMinor: 249900, currency: 'HTG' },
          referenceCost: { amountMinor: 1800, currency: 'USD' },
          barcodes: ['0885140123456'],
        },
      ],
    });
    expect(product.brand?.name).toBe('Steve Madden');
    expect(product.variants[0]?.sellingPrice).toEqual({ amountMinor: 249900, currency: 'HTG' });
    expect(product.variants[0]?.referenceCost?.currency).toBe('USD');
  });

  it('no longer carries the variant signature', () => {
    // Internal identity, and clients were always told to treat it as opaque, so
    // it is stripped rather than sent. The column still exists.
    const parsed = productVariantSchema.parse({ ...VARIANT, variantSignature: '[]' });
    expect(parsed).not.toHaveProperty('variantSignature');
  });

  it('accepts only the three lifecycle statuses', () => {
    for (const status of ['ACTIVE', 'DISCONTINUED', 'ARCHIVED']) {
      expect(productSchema.safeParse({ ...PRODUCT, lifecycleStatus: status }).success).toBe(true);
    }
    for (const status of ['active', 'DELETED', 'INACTIVE', '']) {
      expect(productSchema.safeParse({ ...PRODUCT, lifecycleStatus: status }).success).toBe(false);
    }
  });
});

describe('money contract', () => {
  it('accepts a whole number of minor units and an uppercase code', () => {
    expect(moneySchema.parse({ amountMinor: 249900, currency: 'HTG' })).toEqual({
      amountMinor: 249900,
      currency: 'HTG',
    });
    expect(moneySchema.safeParse({ amountMinor: 0, currency: 'USD' }).success).toBe(true);
  });

  it('refuses a negative amount', () => {
    expect(moneySchema.safeParse({ amountMinor: -1, currency: 'HTG' }).success).toBe(false);
  });

  it('refuses a fractional amount, because minor units are whole', () => {
    // 24.99 in a field that means centimes is somebody who meant 2499.
    expect(moneySchema.safeParse({ amountMinor: 24.99, currency: 'HTG' }).success).toBe(false);
  });

  it('refuses an amount beyond the safe-integer assumption the column is read under', () => {
    expect(
      moneySchema.safeParse({ amountMinor: Number.MAX_SAFE_INTEGER, currency: 'HTG' }).success,
    ).toBe(true);
    expect(
      moneySchema.safeParse({ amountMinor: Number.MAX_SAFE_INTEGER + 2, currency: 'HTG' }).success,
    ).toBe(false);
  });

  it('refuses anything that is not a three-letter uppercase code', () => {
    for (const currency of ['htg', 'US$', 'DOLLARS', ' HTG', 'HT', '']) {
      expect(moneySchema.safeParse({ amountMinor: 1, currency }).success).toBe(false);
    }
  });

  it('accepts a currency nobody wrote a list of', () => {
    // A shape and not a list: taking payment in another currency must not need
    // a release (INV-17).
    expect(moneySchema.safeParse({ amountMinor: 1, currency: 'XPF' }).success).toBe(true);
  });

  it('refuses an amount without its currency', () => {
    expect(moneySchema.safeParse({ amountMinor: 100 }).success).toBe(false);
    expect(moneySchema.safeParse({ currency: 'HTG' }).success).toBe(false);
  });
});
