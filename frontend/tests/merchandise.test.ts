import { describe, expect, it } from 'vitest';
import { createProductRequestSchema, PRODUCT_DESCRIPTION_MAX_LENGTH } from '@ekon/shared';
import {
  emptyNewProduct,
  emptyVariant,
  toCreateProductRequest,
  validateNewProductForm,
  type NewProductFormValues,
  type VariantDraft,
} from '../src/lib/merchandise.js';

/**
 * The rules of entering merchandise, without the markup.
 *
 * The screen's own tests drive the form through the DOM; these are here because
 * these are decisions — what counts as a filled-in attribute, when two variants
 * are the same item, what an absent price means, what actually leaves the
 * browser — and they are worth reading and failing on their own.
 */

function form(values: Partial<NewProductFormValues> = {}): NewProductFormValues {
  return { ...emptyNewProduct(), ...values };
}

function variant(values: Partial<VariantDraft> = {}): VariantDraft {
  return { ...emptyVariant(), ...values };
}

describe('emptyNewProduct', () => {
  it('is a product with one variant and nothing on it', () => {
    // The simplest merchandise a shop can enter: a name, sold one way.
    expect(emptyNewProduct()).toEqual({
      name: '',
      description: '',
      brand: '',
      classifications: {},
      variants: [
        {
          attributes: [],
          sellingPrice: { amount: '', currency: '' },
          referenceCost: { amount: '', currency: '' },
          barcodes: [],
        },
      ],
    });
  });

  it('opens with no attribute row at all', () => {
    // A product sold one way has no attributes, and an empty name/value pair
    // sitting there would imply the shop owes the form two more answers.
    expect(emptyNewProduct().variants[0]?.attributes).toEqual([]);
  });

  it('guesses no currency', () => {
    // There is no configured default anywhere in the system, and this shop buys
    // in one currency and sells in another. A prefilled `HTG` would be putting
    // a currency into a price nobody chose.
    expect(emptyNewProduct().variants[0]?.sellingPrice.currency).toBe('');
  });

  it('hands out a fresh value each time', () => {
    // Nested and mutable: a shared constant would let one product's variants
    // end up on the next one's form.
    const first = emptyNewProduct();
    first.variants[0]?.attributes.push({ name: 'color', value: 'Nwa' });
    expect(emptyNewProduct().variants[0]?.attributes).toEqual([]);
  });
});

describe('validateNewProductForm', () => {
  it('accepts merchandise that is only a name', () => {
    // Brand, classification, price and barcode are all things a shop may not
    // know yet, and refusing the product until it does would stop the work.
    expect(validateNewProductForm(form({ name: 'Diri' }))).toEqual({});
  });

  it('requires a name', () => {
    expect(validateNewProductForm(form({ name: '   ' })).name).toBe('catalog.nameRequired');
  });

  it('bounds name and description by the shared maxima', () => {
    // The bound comes from the contract, so the form cannot accept what the
    // server refuses — and a person is told before the round trip, not after.
    const long = form({
      name: 'Diri',
      description: 'a'.repeat(PRODUCT_DESCRIPTION_MAX_LENGTH + 1),
    });
    expect(validateNewProductForm(long).description).toBe('catalog.descriptionTooLong');
  });

  it('ignores an attribute row nobody filled in', () => {
    const values = form({
      name: 'Diri',
      variants: [variant({ attributes: [{ name: '', value: '' }] })],
    });
    expect(validateNewProductForm(values)).toEqual({});
  });

  it('refuses half of an attribute, either half', () => {
    const noValue = form({
      name: 'Diri',
      variants: [variant({ attributes: [{ name: 'size', value: '' }] })],
    });
    expect(validateNewProductForm(noValue).attributes).toEqual({
      '0.0': 'catalog.attributeValueRequired',
    });

    const noName = form({
      name: 'Diri',
      variants: [variant({ attributes: [{ name: '', value: '38' }] })],
    });
    expect(validateNewProductForm(noName).attributes).toEqual({
      '0.0': 'catalog.attributeNameRequired',
    });
  });

  it('refuses the same attribute name twice on one variant', () => {
    // Attributes cross the wire as a JSON object, so two rows with one name
    // collapse into a single key and the server never learns the second
    // existed. Saying so beats silently dropping what somebody typed.
    const values = form({
      name: 'Bel Ami',
      variants: [
        variant({
          attributes: [
            { name: 'size', value: '38' },
            { name: 'size', value: '39' },
          ],
        }),
      ],
    });
    expect(validateNewProductForm(values).attributes).toEqual({
      '0.1': 'catalog.duplicateAttribute',
    });
  });

  it('refuses two variants that are the same item', () => {
    const values = form({
      name: 'Bel Ami',
      variants: [
        variant({ attributes: [{ name: 'size', value: '38' }] }),
        variant({ attributes: [{ name: 'size', value: '38' }] }),
      ],
    });
    expect(validateNewProductForm(values).variants).toEqual({ '1': 'catalog.duplicateVariant' });
  });

  it('sees through capitalization and entry order', () => {
    // `Nwa` and `nwa` are one colour, and the catalog's variant signature does
    // not care which attribute somebody typed first.
    const values = form({
      name: 'Bel Ami',
      variants: [
        variant({
          attributes: [
            { name: 'color', value: 'Nwa' },
            { name: 'size', value: '38' },
          ],
        }),
        variant({
          attributes: [
            { name: 'size', value: '38' },
            { name: 'color', value: 'nwa' },
          ],
        }),
      ],
    });
    expect(validateNewProductForm(values).variants).toEqual({ '1': 'catalog.duplicateVariant' });
  });

  it('treats two attribute-less variants as the same item', () => {
    const values = form({ name: 'Lwil', variants: [variant(), variant()] });
    expect(validateNewProductForm(values).variants).toEqual({ '1': 'catalog.duplicateVariant' });
  });

  it('says nothing about duplicate variants while an attribute is unfinished', () => {
    // A variant with an unusable attribute has no settled identity yet, so
    // calling it a duplicate too would be a second complaint about one row.
    const values = form({
      name: 'Bel Ami',
      variants: [
        variant({ attributes: [{ name: 'size', value: '38' }] }),
        variant({ attributes: [{ name: 'size', value: '' }] }),
      ],
    });
    const errors = validateNewProductForm(values);
    expect(errors.attributes).toEqual({ '1.0': 'catalog.attributeValueRequired' });
    expect(errors.variants).toBeUndefined();
  });

  describe('money', () => {
    it('accepts a price that is not there at all', () => {
      // Nobody has established one. That is an ordinary state, not an omission.
      expect(validateNewProductForm(form({ name: 'Diri' })).money).toBeUndefined();
    });

    it('refuses half an amount, either half', () => {
      // An amount without a currency cannot be compared, displayed or added to
      // anything, and a currency without an amount is noise (INV-17).
      const noCurrency = form({
        name: 'Diri',
        variants: [variant({ sellingPrice: { amount: '7500', currency: '' } })],
      });
      expect(validateNewProductForm(noCurrency).money).toEqual({
        '0.price': 'catalog.moneyIncomplete',
      });

      const noAmount = form({
        name: 'Diri',
        variants: [variant({ referenceCost: { amount: '', currency: 'USD' } })],
      });
      expect(validateNewProductForm(noAmount).money).toEqual({
        '0.cost': 'catalog.moneyIncomplete',
      });
    });

    it('tells a bad amount from a bad currency', () => {
      // Two different mistakes with two different fixes, so two sentences.
      const badAmount = form({
        name: 'Diri',
        variants: [variant({ sellingPrice: { amount: '1,500.00', currency: 'HTG' } })],
      });
      expect(validateNewProductForm(badAmount).money).toEqual({
        '0.price': 'catalog.moneyInvalid',
      });

      const badCurrency = form({
        name: 'Diri',
        variants: [variant({ sellingPrice: { amount: '7500', currency: 'gourde' } })],
      });
      expect(validateNewProductForm(badCurrency).money).toEqual({
        '0.price': 'catalog.currencyInvalid',
      });
    });

    it('accepts a price and a cost in different currencies', () => {
      // Bought in dollars, sold in gourdes: the ordinary case for this shop,
      // and the reason a single shop-wide currency would be wrong.
      const values = form({
        name: 'Bel Ami',
        variants: [
          variant({
            sellingPrice: { amount: '7500,00', currency: 'htg' },
            referenceCost: { amount: '40.00', currency: 'usd' },
          }),
        ],
      });
      expect(validateNewProductForm(values)).toEqual({});
    });
  });

  describe('barcodes', () => {
    it('ignores a blank line', () => {
      const values = form({ name: 'Diri', variants: [variant({ barcodes: ['', '  '] })] });
      expect(validateNewProductForm(values)).toEqual({});
    });

    it('refuses a code with a space in it', () => {
      // Whatever was pasted, it is not one barcode.
      const values = form({
        name: 'Diri',
        variants: [variant({ barcodes: ['012 345'] })],
      });
      expect(validateNewProductForm(values).barcodes).toEqual({ '0.0': 'catalog.barcodeSpace' });
    });

    it('refuses the same code twice on one variant', () => {
      const values = form({
        name: 'Diri',
        variants: [variant({ barcodes: ['0123456789012', '0123456789012'] })],
      });
      expect(validateNewProductForm(values).barcodes).toEqual({
        '0.1': 'catalog.barcodeDuplicate',
      });
    });
  });
});

describe('toCreateProductRequest', () => {
  it('produces a body the shared contract accepts', () => {
    const body = toCreateProductRequest(
      form({
        name: 'Bel Ami',
        description: 'Soulye fanm',
        brand: 'Steve Madden',
        classifications: { audience: 'Fanm', category: 'Soulye' },
        variants: [
          variant({
            attributes: [{ name: 'size', value: '38' }],
            sellingPrice: { amount: '7500.00', currency: 'HTG' },
            referenceCost: { amount: '40.00', currency: 'USD' },
            barcodes: ['0123456789012'],
          }),
        ],
      }),
    );

    expect(createProductRequestSchema.safeParse(body).success).toBe(true);
  });

  it('converts money to minor units without floating point', () => {
    // The amount that reaches the server is the amount somebody typed. This is
    // the assertion the string implementation exists for.
    const body = toCreateProductRequest(
      form({
        name: 'Diri',
        variants: [
          variant({
            sellingPrice: { amount: '7500.55', currency: 'htg' },
            referenceCost: { amount: '0,05', currency: 'usd' },
          }),
        ],
      }),
    );

    expect(body.variants[0]?.sellingPrice).toEqual({ amountMinor: 750055, currency: 'HTG' });
    expect(body.variants[0]?.referenceCost).toEqual({ amountMinor: 5, currency: 'USD' });
  });

  it('omits an absent price rather than sending a zero', () => {
    // Zero means the item is free, and somebody would eventually compute a
    // margin from it. Absent means nobody has established a price.
    const body = toCreateProductRequest(form({ name: 'Diri' }));

    expect(body.variants[0]).not.toHaveProperty('sellingPrice');
    expect(body.variants[0]).not.toHaveProperty('referenceCost');
  });

  it('passes attribute names and values through as they were typed', () => {
    // The catalog normalizes both; doing it here would be the browser deciding
    // something the catalog owns, and the two would drift.
    const body = toCreateProductRequest(
      form({
        name: 'Bel Ami',
        variants: [variant({ attributes: [{ name: 'color', value: 'Nwa' }] })],
      }),
    );

    expect(body.variants[0]?.attributes).toEqual({ color: 'Nwa' });
  });

  it('drops attribute and barcode rows nobody filled in', () => {
    const body = toCreateProductRequest(
      form({
        name: 'Diri',
        variants: [
          variant({
            attributes: [
              { name: 'size', value: '38' },
              { name: '', value: '' },
            ],
            barcodes: ['0123456789012', '   '],
          }),
        ],
      }),
    );

    expect(body.variants[0]?.attributes).toEqual({ size: '38' });
    expect(body.variants[0]?.barcodes).toEqual(['0123456789012']);
  });

  it('omits a blank brand and description rather than sending empty ones', () => {
    // An empty string is a brand named nothing, which the catalog would then
    // have to resolve or create.
    const body = toCreateProductRequest(form({ name: 'Diri' }));

    expect(body).not.toHaveProperty('brand');
    expect(body).not.toHaveProperty('description');
  });

  it('sends only the dimensions somebody chose a value for', () => {
    // Unclassified merchandise is a real state, and an empty string would be a
    // classification value of nothing.
    const body = toCreateProductRequest(
      form({ name: 'Diri', classifications: { audience: '', category: 'Manje' } }),
    );

    expect(body.classifications).toEqual({ category: 'Manje' });
  });

  it('carries no field the server owns', () => {
    // The SKU, the variant id and the lifecycle status are the catalog's to
    // decide. A form that sent them would be claiming authority it lacks.
    const body = toCreateProductRequest(
      form({ name: 'Diri', variants: [variant({ attributes: [{ name: 'size', value: '38' }] })] }),
    );

    expect(body.variants[0]).not.toHaveProperty('sku');
    expect(body.variants[0]).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('lifecycleStatus');
    expect(body).not.toHaveProperty('isActive');
  });
});
