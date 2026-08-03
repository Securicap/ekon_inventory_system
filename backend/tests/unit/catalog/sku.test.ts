import { describe, expect, it } from 'vitest';
import { SKU_PATTERN } from '@ekon/shared';
import {
  SKU_ALPHABET,
  SKU_PREFIX,
  SKU_SUFFIX_LENGTH,
  generateSku,
} from '../../../src/modules/catalog/domain/sku.js';

describe('generateSku', () => {
  it('matches the shared SKU format', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateSku()).toMatch(SKU_PATTERN);
    }
  });

  it('is EKN- plus exactly eight suffix characters', () => {
    const sku = generateSku();
    expect(sku.startsWith(SKU_PREFIX)).toBe(true);
    expect(sku.length).toBe(SKU_PREFIX.length + SKU_SUFFIX_LENGTH);
  });

  it('only uses the unambiguous alphabet (no 0, 1, I, O)', () => {
    const suffixes = Array.from({ length: 200 }, () => generateSku().slice(SKU_PREFIX.length));
    for (const suffix of suffixes) {
      for (const char of suffix) {
        expect(SKU_ALPHABET, `unexpected character ${char}`).toContain(char);
      }
    }
    expect(SKU_ALPHABET).not.toMatch(/[01IO]/);
  });

  it('is non-semantic: overwhelmingly unique across many draws', () => {
    // Not a claim of guaranteed uniqueness — the database enforces that — but a
    // check that the suffix carries real entropy rather than being predictable.
    const skus = new Set(Array.from({ length: 10_000 }, () => generateSku()));
    expect(skus.size).toBeGreaterThan(9_990);
  });
});
