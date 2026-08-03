import { describe, expect, it } from 'vitest';
import {
  AttributeNormalizationError,
  buildVariantSignature,
  identityAttributeValue,
  normalizeAttributeName,
  normalizeAttributeValue,
  normalizeAttributes,
} from '../../../src/modules/catalog/domain/variantSignature.js';

describe('attribute normalization', () => {
  it('trims and lower-cases names', () => {
    expect(normalizeAttributeName('  Color ')).toBe('color');
    expect(normalizeAttributeName('SIZE')).toBe('size');
  });

  it('keeps the display value trimmed but case-preserved', () => {
    expect(normalizeAttributeValue('  White ')).toBe('White');
    expect(normalizeAttributeValue('9')).toBe('9');
  });

  it('derives a lower-cased identity value for comparison', () => {
    expect(identityAttributeValue('White')).toBe('white');
    expect(identityAttributeValue('  WHITE ')).toBe('white');
    expect(identityAttributeValue('Navy Blue')).toBe('navy blue');
  });

  it('normalizes a whole attribute object, sorted by name, with display + identity', () => {
    const result = normalizeAttributes(
      { ' Size ': ' 9 ', Color: ' White ' },
      'variants.0.attributes',
    );
    expect(result).toEqual([
      { name: 'color', value: 'White', identityValue: 'white' },
      { name: 'size', value: '9', identityValue: '9' },
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
  const sig = (attrs: Record<string, string>): string =>
    buildVariantSignature(normalizeAttributes(attrs, 'v'));

  it('is identical regardless of input order', () => {
    expect(sig({ color: 'White', size: '9' })).toBe(sig({ size: '9', color: 'White' }));
  });

  it('is case-insensitive on values (the new rule)', () => {
    const canonical = sig({ color: 'White' });
    expect(sig({ color: 'white' })).toBe(canonical);
    expect(sig({ color: ' WHITE ' })).toBe(canonical);
    expect(sig({ color: 'wHiTe' })).toBe(canonical);
  });

  it('is case-insensitive on multi-word values', () => {
    expect(sig({ color: 'Navy Blue' })).toBe(sig({ color: 'navy blue' }));
  });

  it('uses the lower-cased identity value in the signature', () => {
    expect(sig({ color: 'White' })).toBe('[["color","white"]]');
  });

  it('still distinguishes genuinely different values', () => {
    expect(sig({ color: 'white' })).not.toBe(sig({ color: 'black' }));
    expect(sig({ size: '9' })).not.toBe(sig({ size: '10' }));
  });

  it('still distinguishes different names', () => {
    expect(sig({ color: 'White' })).not.toBe(sig({ finish: 'White' }));
  });

  it('produces a stable signature for the empty (default) variant', () => {
    expect(buildVariantSignature([])).toBe('[]');
    expect(sig({})).toBe('[]');
  });

  it('serializes values with quotes and punctuation unambiguously', () => {
    // The name/value boundary must stay unambiguous even with tricky characters.
    expect(sig({ a: 'b', c: 'd' })).not.toBe(sig({ a: 'b=c=d' }));
    // A quote in a value is JSON-escaped, not left to collide.
    expect(sig({ note: 'a"b' })).toBe('[["note","a\\"b"]]');
    expect(sig({ note: '50%, "x"' })).toBe('[["note","50%, \\"x\\""]]');
  });

  it('applies ordinary Unicode lower-casing to accented values', () => {
    // Latin-script accents lower-case the same way SQL lower() does under the
    // ICU en-US locale, which is what the migration relies on.
    expect(sig({ color: 'CAFÉ' })).toBe(sig({ color: 'café' }));
    expect(sig({ color: 'Café' })).toBe('[["color","café"]]');
  });
});
