import { describe, expect, it } from 'vitest';
import { formatVariantAttributes, formatVariantLabel } from '../src/lib/variants.js';

/**
 * How a variant is named to a person — the one answer three screens share.
 *
 * Receiving and removal put the whole label inside an `<option>`; the stock
 * screen breaks it apart and shows the attributes on their own line. If these
 * ever disagreed, an employee would be asked to notice that two differently
 * written lines are the same item, in the middle of a stock count.
 */

describe('naming a variant', () => {
  it('reads as product, attributes, and SKU', () => {
    expect(
      formatVariantLabel(
        'Chemiz',
        [
          { name: 'gwosè', value: 'Gran' },
          { name: 'koulè', value: 'Ble' },
        ],
        'EKN-AB12CD34',
      ),
    ).toBe('Chemiz — gwosè: Gran, koulè: Ble — EKN-AB12CD34');
  });

  it('leaves out an empty attribute list rather than an empty gap', () => {
    expect(formatVariantLabel('Lwil', [], 'EKN-EF56GH78')).toBe('Lwil — EKN-EF56GH78');
  });

  it('is built from the same attribute formatting the stock screen shows', () => {
    const attributes = [{ name: 'gwosè', value: '5 mamit' }];
    expect(formatVariantLabel('Diri', attributes, 'EKN-AB12CD34')).toContain(
      formatVariantAttributes(attributes),
    );
  });

  it('keeps the shop’s own words as they were typed', () => {
    // Attribute names and values are entered by the business, so they are shown
    // rather than translated or re-cased.
    expect(formatVariantAttributes([{ name: 'mak', value: 'Tchako' }])).toBe('mak: Tchako');
  });
});
