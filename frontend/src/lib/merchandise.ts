import {
  BARCODE_MAX_LENGTH,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  type CreateProductRequest,
} from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';
import { normalizeCurrency, parseMoneyAmount } from './money.js';

/**
 * Entering merchandise: the parts that are decisions rather than markup.
 *
 * The merchandise model is richer than the temporary form that preceded it —
 * brand, classification, controlled attributes, price, cost, barcodes — and the
 * job here is to keep it from becoming intimidating. Every rule below exists to
 * make a mistake a sentence under a field rather than a round trip, and every
 * bound comes from `@ekon/shared` so this form cannot accept what the server
 * refuses.
 *
 * Two things it deliberately does **not** do:
 *
 *  - it does not invent an attribute name. Names are structure and the catalog
 *    refuses an undefined one, so the form offers what exists and this never
 *    validates a typed one;
 *  - it does not compute money with floating point. `parseMoneyAmount` reads
 *    digits as text; a price is stored exactly as somebody typed it.
 */

/** One attribute of one variant: a name from the vocabulary, and a free value. */
export interface AttributeDraft {
  /** The normalized name, chosen from `variantAttributeDefinitions`. */
  name: string;
  value: string;
}

/** One price or cost, as the DOM holds it: two strings. */
export interface MoneyDraft {
  amount: string;
  currency: string;
}

export interface VariantDraft {
  attributes: AttributeDraft[];
  sellingPrice: MoneyDraft;
  referenceCost: MoneyDraft;
  /** One line per barcode. Optional, and usually empty. */
  barcodes: string[];
}

export interface NewProductFormValues {
  name: string;
  description: string;
  /** A brand *name*, typed or picked. The server resolves it, or creates it. */
  brand: string;
  /** Keyed by dimension key: `{ audience: 'Women', category: 'Footwear' }`. */
  classifications: Record<string, string>;
  variants: VariantDraft[];
}

export interface NewProductFieldErrors {
  name?: MessageKey;
  description?: MessageKey;
  brand?: MessageKey;
  /** Keyed `"variantIndex.attributeIndex"`. */
  attributes?: Record<string, MessageKey>;
  /** Keyed `"variantIndex.price"` and `"variantIndex.cost"`. */
  money?: Record<string, MessageKey>;
  /** Keyed `"variantIndex.barcodeIndex"`. */
  barcodes?: Record<string, MessageKey>;
  /** Keyed by variant index: this variant repeats an earlier one. */
  variants?: Record<string, MessageKey>;
}

/**
 * A blank form: a nameless product with one variant and nothing filled in.
 *
 * A function rather than a constant because the value is nested and mutable — a
 * shared object would let one product's variants end up on the next one's form.
 *
 * The currency starts empty rather than at `HTG` or `USD`. This shop buys in one
 * currency and sells in another routinely, there is no configured default
 * anywhere in the system, and a form that guessed would be putting a currency
 * into a price nobody chose.
 */
export function emptyNewProduct(): NewProductFormValues {
  return {
    name: '',
    description: '',
    brand: '',
    classifications: {},
    variants: [emptyVariant()],
  };
}

export function emptyVariant(): VariantDraft {
  return {
    attributes: [],
    sellingPrice: { amount: '', currency: '' },
    referenceCost: { amount: '', currency: '' },
    barcodes: [],
  };
}

/** A row somebody actually filled in. An untouched pair is not an error. */
function isFilled(attribute: AttributeDraft): boolean {
  return attribute.name.trim() !== '' || attribute.value.trim() !== '';
}

/** An amount is a pair: both halves, or neither. */
function moneyState(money: MoneyDraft): 'empty' | 'complete' | 'partial' {
  const amount = money.amount.trim() !== '';
  const currency = money.currency.trim() !== '';
  if (!amount && !currency) return 'empty';
  return amount && currency ? 'complete' : 'partial';
}

export function validateNewProductForm(values: NewProductFormValues): NewProductFieldErrors {
  const errors: NewProductFieldErrors = {};
  const attributes: Record<string, MessageKey> = {};
  const money: Record<string, MessageKey> = {};
  const barcodes: Record<string, MessageKey> = {};
  const variants: Record<string, MessageKey> = {};

  const name = values.name.trim();
  if (name === '') {
    errors.name = 'catalog.nameRequired';
  } else if (name.length > PRODUCT_NAME_MAX_LENGTH) {
    errors.name = 'catalog.nameTooLong';
  }

  if (values.description.trim().length > PRODUCT_DESCRIPTION_MAX_LENGTH) {
    errors.description = 'catalog.descriptionTooLong';
  }

  /** Each variant's identity, to catch a product carrying the same one twice. */
  const signatures = new Map<string, number>();

  values.variants.forEach((variant, variantIndex) => {
    const seen = new Set<string>();
    const identity: [string, string][] = [];

    variant.attributes.forEach((attribute, attributeIndex) => {
      if (!isFilled(attribute)) return;

      const key = `${variantIndex}.${attributeIndex}`;
      const attributeName = attribute.name.trim();
      const value = attribute.value.trim();

      if (attributeName === '') {
        attributes[key] = 'catalog.attributeNameRequired';
      } else if (value === '') {
        attributes[key] = 'catalog.attributeValueRequired';
      } else if (seen.has(attributeName)) {
        // Attributes cross the wire as a JSON *object*, so two rows with one
        // name collapse into a single key and the server never learns the
        // second existed. Refusing it here is the difference between saying so
        // and silently dropping what somebody typed.
        attributes[key] = 'catalog.duplicateAttribute';
      } else {
        seen.add(attributeName);
        identity.push([attributeName, value.toLowerCase()]);
      }
    });

    for (const [field, draft] of [
      ['price', variant.sellingPrice],
      ['cost', variant.referenceCost],
    ] as const) {
      const state = moneyState(draft);
      if (state === 'empty') continue;

      const key = `${variantIndex}.${field}`;
      if (state === 'partial') {
        // An amount without a currency cannot be compared, displayed or added
        // to anything, and a currency without an amount is noise (INV-17).
        money[key] = 'catalog.moneyIncomplete';
      } else if (!parseMoneyAmount(draft.amount).ok) {
        money[key] = 'catalog.moneyInvalid';
      } else if (normalizeCurrency(draft.currency) === null) {
        money[key] = 'catalog.currencyInvalid';
      }
    }

    const codes = new Set<string>();
    variant.barcodes.forEach((barcode, barcodeIndex) => {
      const code = barcode.trim();
      if (code === '') return;
      const key = `${variantIndex}.${barcodeIndex}`;
      if (code.length > BARCODE_MAX_LENGTH) {
        barcodes[key] = 'catalog.barcodeTooLong';
      } else if (/\s/.test(code)) {
        barcodes[key] = 'catalog.barcodeSpace';
      } else if (codes.has(code)) {
        barcodes[key] = 'catalog.barcodeDuplicate';
      } else {
        codes.add(code);
      }
    });

    const signature = JSON.stringify(
      [...identity].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    );
    if (signatures.has(signature)) {
      variants[String(variantIndex)] = 'catalog.duplicateVariant';
    } else {
      signatures.set(signature, variantIndex);
    }
  });

  if (Object.keys(attributes).length > 0) errors.attributes = attributes;
  if (Object.keys(money).length > 0) errors.money = money;
  if (Object.keys(barcodes).length > 0) errors.barcodes = barcodes;
  // A variant with an unusable attribute has no settled identity yet, so
  // reporting it as a duplicate as well would be a second complaint about one
  // unfinished row.
  if (Object.keys(attributes).length === 0 && Object.keys(variants).length > 0) {
    errors.variants = variants;
  }

  return errors;
}

/**
 * The form, as the contract wants it.
 *
 * The one transformation that matters is money: `"7500.50"` and `"htg"` become
 * `{ amountMinor: 750050, currency: 'HTG' }`, through string arithmetic. Empty
 * price and cost are **omitted** rather than sent as zero, because `null` in
 * this contract means "nobody has established one" and zero would mean the item
 * is free.
 *
 * Everything else is passed through as typed. The shared schema trims the name
 * and the server normalizes attribute names and classification values, and
 * doing either here would be the browser deciding something the catalog owns.
 */
export function toCreateProductRequest(values: NewProductFormValues): CreateProductRequest {
  const description = values.description.trim();
  const brand = values.brand.trim();

  return {
    name: values.name,
    ...(description === '' ? {} : { description }),
    ...(brand === '' ? {} : { brand }),
    // Only the dimensions somebody actually chose a value for. An unclassified
    // product is a real state, and an empty string would be a classification
    // value of nothing.
    classifications: Object.fromEntries(
      Object.entries(values.classifications).filter(([, value]) => value.trim() !== ''),
    ),
    variants: values.variants.map((variant) => ({
      attributes: Object.fromEntries(
        variant.attributes
          .filter(isFilled)
          .map((attribute) => [attribute.name, attribute.value] as const),
      ),
      ...moneyField('sellingPrice', variant.sellingPrice),
      ...moneyField('referenceCost', variant.referenceCost),
      barcodes: variant.barcodes.map((barcode) => barcode.trim()).filter((code) => code !== ''),
    })),
  };
}

function moneyField(
  field: 'sellingPrice' | 'referenceCost',
  draft: MoneyDraft,
): Record<string, { amountMinor: number; currency: string }> {
  if (moneyState(draft) !== 'complete') return {};

  const amount = parseMoneyAmount(draft.amount);
  const currency = normalizeCurrency(draft.currency);
  // Unreachable: validation refuses either of these before submission. Guarded
  // because the alternative is putting a `NaN` price on the wire.
  if (!amount.ok || currency === null) return {};

  return { [field]: { amountMinor: amount.amountMinor, currency } };
}
