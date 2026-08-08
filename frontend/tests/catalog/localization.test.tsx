import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fr from '../../src/i18n/fr.json';
import ht from '../../src/i18n/ht.json';
import { translate, type MessageKey } from '../../src/i18n/index.js';
import { openNewProduct } from '../helpers/catalog.js';

/**
 * Every string this workflow added exists in both languages, and the screen
 * reads its text from the catalogue rather than from the component.
 *
 * Employees use this in Haitian Creole and the owner reads French. The
 * application renders in Creole today because there is no language selector;
 * French is asserted through the catalogue, which is what the selector will
 * read when it arrives.
 */
const KEYS_ADDED_BY_PRODUCT_CREATION = [
  'catalog.newProduct',
  'catalog.newProductTitle',
  'catalog.newProductDescription',
  'catalog.productName',
  'catalog.productNameHint',
  'catalog.productDescription',
  'catalog.variantsLegend',
  'catalog.variantsHint',
  'catalog.variantNumber',
  'catalog.addVariant',
  'catalog.removeVariant',
  'catalog.attributeName',
  'catalog.attributeValue',
  'catalog.addAttribute',
  'catalog.removeAttribute',
  'catalog.submit',
  'catalog.submitting',
  'catalog.created',
  'catalog.createdHint',
  'catalog.nameRequired',
  'catalog.nameTooLong',
  'catalog.descriptionTooLong',
  'catalog.attributeNameRequired',
  'catalog.attributeValueRequired',
  'catalog.duplicateAttribute',
  'catalog.duplicateVariant',
  'catalog.variantExists',
  'catalog.uncertain',
  'catalog.checkList',
] as const satisfies readonly MessageKey[];

describe('localization', () => {
  it.each(KEYS_ADDED_BY_PRODUCT_CREATION)('has %s in both catalogues', (key) => {
    expect(ht[key]).toBeTruthy();
    expect(fr[key as keyof typeof fr]).toBeTruthy();
  });

  it('translates every one of them to something different in each language', () => {
    // A key copied across untranslated is the failure this catches: the French
    // catalogue is not a duplicate of the Creole one.
    for (const key of KEYS_ADDED_BY_PRODUCT_CREATION) {
      expect(translate('fr', key), key).not.toBe(translate('ht', key));
    }
  });

  it('keeps the placeholders a message promises', () => {
    for (const [key, placeholder] of [
      ['catalog.variantNumber', '{number}'],
      ['catalog.removeVariant', '{number}'],
      ['catalog.created', '{name}'],
      ['catalog.createdHint', '{skus}'],
      ['catalog.nameTooLong', '{max}'],
      ['catalog.descriptionTooLong', '{max}'],
    ] as const) {
      expect(ht[key], key).toContain(placeholder);
      expect(fr[key], key).toContain(placeholder);
    }
  });

  it('substitutes them rather than printing the braces', () => {
    expect(translate('ht', 'catalog.created', { name: 'Diri' })).toContain('Diri');
    expect(translate('ht', 'catalog.created', { name: 'Diri' })).not.toContain('{name}');
    expect(translate('fr', 'catalog.createdHint', { skus: 'EKN-AB12CD34' })).toContain(
      'EKN-AB12CD34',
    );
  });

  it('renders the form from the catalogue, in the primary language', async () => {
    await openNewProduct();

    expect(screen.getByText(ht['catalog.newProductDescription'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['catalog.productName'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['catalog.productDescription'])).toBeInTheDocument();
    expect(screen.getByText(ht['catalog.variantsHint'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['catalog.addAttribute'] })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['catalog.addVariant'] })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['catalog.submit'] })).toBeInTheDocument();
  });
});
