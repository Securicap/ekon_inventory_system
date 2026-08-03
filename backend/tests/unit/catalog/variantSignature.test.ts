import { describe, expect, it } from 'vitest';
import {
  AttributeNormalizationError,
  buildVariantSignature,
  normalizeAttributeName,
  normalizeAttributeValue,
  normalizeAttributes,
} from '../../../src/modules/catalog/domain/variantSignature.js';

describe('attribute normalization', () => {
  it('trims and lower-cases names', () => {
    expect(normalizeAttributeName('  Color ')).toBe('color');
    expect(normalizeAttributeName('SIZE')).toBe('size');
  });

  it('trims values but preserves their case', () => {
    expect(normalizeAttributeValue('  White ')).toBe('White');
    expect(normalizeAttributeValue('9')).toBe('9');
  });

  it('normalizes a whole attribute object, sorted by name', () => {
    const result = normalizeAttributes(
      { ' Size ': ' 9 ', Color: 'White' },
      'variants.0.attributes',
    );
    expect(result).toEqual([
      { name: 'color', value: 'White' },
      { name: 'size', value: '9' },
    ]);
  });

  it('rejects a blank name or value with field-level detail', () => {
    expect(() => normalizeAttributes({ '   ': 'White' }, 'v')).toThrow(AttributeNormalizationError);
    expect(() => normalizeAttributes({ color: '   ' }, 'v')).toThrow(AttributeNormalizationError);
    try {
      normalizeAttributes({ color: '   ' }, 'variants.0.attributes');
    } catch (error) {
      expect(error).toBeInstanceOf(AttributeNormalizationError);
      expect((error as AttributeNormalizationError).details[0]?.path).toContain(
        'variants.0.attributes',
      );
    }
  });

  it('rejects two names that collide after normalization', () => {
    try {
      normalizeAttributes({ Color: 'White', ' color ': 'Black' }, 'v');
      throw new Error('expected normalization to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AttributeNormalizationError);
      const details = (error as AttributeNormalizationError).details;
      expect(details.some((d) => /Duplicate attribute name/.test(d.message))).toBe(true);
    }
  });
});

describe('buildVariantSignature', () => {
  it('is identical regardless of input order', () => {
    const a = normalizeAttributes({ color: 'White', size: '9' }, 'v');
    const b = normalizeAttributes({ size: '9', color: 'White' }, 'v');
    expect(buildVariantSignature(a)).toBe(buildVariantSignature(b));
  });

  it('distinguishes different values', () => {
    const white = normalizeAttributes({ color: 'White' }, 'v');
    const black = normalizeAttributes({ color: 'Black' }, 'v');
    expect(buildVariantSignature(white)).not.toBe(buildVariantSignature(black));
  });

  it('distinguishes different names', () => {
    const color = normalizeAttributes({ color: 'White' }, 'v');
    const finish = normalizeAttributes({ finish: 'White' }, 'v');
    expect(buildVariantSignature(color)).not.toBe(buildVariantSignature(finish));
  });

  it('produces a stable signature for the empty (default) variant', () => {
    expect(buildVariantSignature([])).toBe('[]');
    expect(buildVariantSignature(normalizeAttributes({}, 'v'))).toBe('[]');
  });

  it('keeps the name/value boundary unambiguous', () => {
    // Two different attribute sets must never collapse to the same signature.
    const one = normalizeAttributes({ a: 'b', c: 'd' }, 'v');
    const two = normalizeAttributes({ a: 'b=c=d' }, 'v');
    expect(buildVariantSignature(one)).not.toBe(buildVariantSignature(two));
  });
});
