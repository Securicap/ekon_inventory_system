import { describe, expect, it } from 'vitest';
import {
  createProductRequestSchema,
  listProductsResponseSchema,
  productVariantSchema,
  SKU_PATTERN,
} from '../src/index.js';

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

describe('catalog response contract', () => {
  it('validates SKUs against the shared format', () => {
    expect(SKU_PATTERN.test('EKN-ABCDEFGH')).toBe(true);
    expect(SKU_PATTERN.test('EKN-lowercase')).toBe(false);
    expect(SKU_PATTERN.test('SKU-ABCDEFGH')).toBe(false);
    expect(
      productVariantSchema.safeParse({
        id: '00000000-0000-7000-8000-000000000000',
        productId: '00000000-0000-7000-8000-000000000001',
        sku: 'not-a-sku',
        variantSignature: '[]',
        isActive: true,
        attributes: [],
        createdAt: '2026-08-03T12:00:00.000Z',
        updatedAt: '2026-08-03T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('treats an empty catalog as an empty array', () => {
    expect(listProductsResponseSchema.parse([])).toEqual([]);
  });
});
