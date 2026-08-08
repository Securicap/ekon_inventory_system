import { describe, expect, it } from 'vitest';
import { createProductRequestSchema, PRODUCT_DESCRIPTION_MAX_LENGTH } from '@ekon/shared';
import {
  emptyNewProduct,
  toCreateProductRequest,
  validateNewProductForm,
  type NewProductFormValues,
} from '../src/lib/catalog.js';

/**
 * The rules of the product form, without the markup.
 *
 * The screen's own tests drive it through the DOM; these are here because these
 * are decisions — what counts as a filled-in attribute, when two variants are
 * the same item, what actually leaves the browser — and they are worth reading
 * and failing on their own.
 */

function form(values: Partial<NewProductFormValues> = {}): NewProductFormValues {
  return { ...emptyNewProduct(), ...values };
}

describe('emptyNewProduct', () => {
  it('is a product with one variant and nothing on it', () => {
    // The simplest thing a shop can create, and what a fresh installation needs
    // on its first day: a name, and the default variant.
    expect(emptyNewProduct()).toEqual({
      name: '',
      description: '',
      variants: [{ attributes: [] }],
    });
  });

  it('hands out a fresh value each time', () => {
    // A shared nested object would let one product's variants end up on the
    // next one's form.
    const first = emptyNewProduct();
    first.variants[0]?.attributes.push({ name: 'gwosè', value: '5 mamit' });
    expect(emptyNewProduct().variants[0]?.attributes).toEqual([]);
  });
});

describe('validateNewProductForm', () => {
  it('accepts a product that is only a name', () => {
    expect(validateNewProductForm(form({ name: 'Diri' }))).toEqual({});
  });

  it('requires a name', () => {
    expect(validateNewProductForm(form({ name: '   ' })).name).toBe('catalog.nameRequired');
  });

  it('bounds the description by the shared maximum', () => {
    const values = form({ name: 'Diri', description: 'a'.repeat(PRODUCT_DESCRIPTION_MAX_LENGTH) });
    expect(validateNewProductForm(values).description).toBeUndefined();

    const tooLong = form({
      name: 'Diri',
      description: 'a'.repeat(PRODUCT_DESCRIPTION_MAX_LENGTH + 1),
    });
    expect(validateNewProductForm(tooLong).description).toBe('catalog.descriptionTooLong');
  });

  it('ignores an attribute row nobody filled in', () => {
    const values = form({ name: 'Diri', variants: [{ attributes: [{ name: '', value: '' }] }] });
    expect(validateNewProductForm(values)).toEqual({});
  });

  it('refuses half of an attribute, either half', () => {
    const noValue = form({
      name: 'Diri',
      variants: [{ attributes: [{ name: 'gwosè', value: ' ' }] }],
    });
    expect(validateNewProductForm(noValue).attributes).toEqual({
      '0.0': 'catalog.attributeValueRequired',
    });

    const noName = form({
      name: 'Diri',
      variants: [{ attributes: [{ name: ' ', value: '5 mamit' }] }],
    });
    expect(validateNewProductForm(noName).attributes).toEqual({
      '0.0': 'catalog.attributeNameRequired',
    });
  });

  it('refuses the same attribute name twice, however it was capitalized', () => {
    // The rule that is not merely a faster round trip: attributes cross the
    // wire as a JSON object, so the second would collapse into the first and
    // the server would never learn it was typed.
    const values = form({
      name: 'Diri',
      variants: [
        {
          attributes: [
            { name: 'Gwosè', value: '5 mamit' },
            { name: ' gwosè ', value: '10 mamit' },
          ],
        },
      ],
    });
    expect(validateNewProductForm(values).attributes).toEqual({
      '0.1': 'catalog.duplicateAttribute',
    });
  });

  it('refuses two variants that are the same item', () => {
    // Identity is case-insensitive on both names and values, as the catalog
    // defines it — the server would refuse this too, one round trip later.
    const values = form({
      name: 'Diri',
      variants: [
        { attributes: [{ name: 'gwosè', value: '5 mamit' }] },
        { attributes: [{ name: 'GWOSÈ', value: '5 Mamit' }] },
      ],
    });
    expect(validateNewProductForm(values).variants).toEqual({ '1': 'catalog.duplicateVariant' });
  });

  it('treats two default variants as the same item', () => {
    const values = form({ name: 'Diri', variants: [{ attributes: [] }, { attributes: [] }] });
    expect(validateNewProductForm(values).variants).toEqual({ '1': 'catalog.duplicateVariant' });
  });

  it('does not care what order the attributes were entered in', () => {
    const values = form({
      name: 'Diri',
      variants: [
        {
          attributes: [
            { name: 'gwosè', value: '5 mamit' },
            { name: 'mak', value: 'Tchako' },
          ],
        },
        {
          attributes: [
            { name: 'mak', value: 'Tchako' },
            { name: 'gwosè', value: '5 mamit' },
          ],
        },
      ],
    });
    expect(validateNewProductForm(values).variants).toEqual({ '1': 'catalog.duplicateVariant' });
  });

  it('says nothing about duplicate variants while an attribute is unfinished', () => {
    // A variant with an unusable row has no settled identity yet, and a second
    // complaint about the same unfinished thing helps nobody.
    const values = form({
      name: 'Diri',
      variants: [{ attributes: [] }, { attributes: [{ name: 'gwosè', value: '' }] }],
    });
    const errors = validateNewProductForm(values);
    expect(errors.attributes).toEqual({ '1.0': 'catalog.attributeValueRequired' });
    expect(errors.variants).toBeUndefined();
  });
});

describe('toCreateProductRequest', () => {
  it('produces a body the shared contract accepts', () => {
    const request = toCreateProductRequest(form({ name: 'Diri' }));
    expect(request).toEqual({ name: 'Diri', variants: [{ attributes: {} }] });
    expect(createProductRequestSchema.safeParse(request).success).toBe(true);
  });

  it('passes attribute names and values through as they were typed', () => {
    // The catalog normalizes them on arrival — trimming, and lower-casing for
    // identity. Doing it here as well would be the browser deciding something
    // the server is the authority on.
    const request = toCreateProductRequest(
      form({ name: 'Diri', variants: [{ attributes: [{ name: 'Gwosè', value: ' 5 mamit ' }] }] }),
    );
    expect(request.variants).toEqual([{ attributes: { Gwosè: ' 5 mamit ' } }]);
  });

  it('drops attribute rows nobody filled in', () => {
    const request = toCreateProductRequest(
      form({
        name: 'Diri',
        variants: [
          {
            attributes: [
              { name: '', value: '' },
              { name: 'gwosè', value: '5 mamit' },
            ],
          },
        ],
      }),
    );
    expect(request.variants).toEqual([{ attributes: { gwosè: '5 mamit' } }]);
  });

  it('omits a blank description rather than sending an empty one', () => {
    expect(toCreateProductRequest(form({ name: 'Diri', description: '  ' }))).not.toHaveProperty(
      'description',
    );
  });

  it('keeps a description that was written', () => {
    expect(
      toCreateProductRequest(form({ name: 'Diri', description: 'Sak 25 liv' })).description,
    ).toBe('Sak 25 liv');
  });

  it('carries no field the server owns', () => {
    const request = toCreateProductRequest(
      form({ name: 'Diri', variants: [{ attributes: [{ name: 'gwosè', value: '5 mamit' }] }] }),
    );
    expect(Object.keys(request).sort()).toEqual(['name', 'variants']);
    expect(Object.keys(request.variants[0] ?? {})).toEqual(['attributes']);
  });
});
