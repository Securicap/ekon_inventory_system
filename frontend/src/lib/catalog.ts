import {
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  type CreateProductRequest,
} from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';

/**
 * The parts of product creation that are decisions rather than markup.
 *
 * Here rather than in the screen because they are rules worth checking without
 * reading JSX, and worth testing directly — the same arrangement `lib/users.ts`
 * uses for account creation. The screen keeps state and layout.
 *
 * Every bound comes from `@ekon/shared`. Nothing here restates how long a
 * product name may be: a second copy of that rule would be a form that accepts
 * what the server refuses.
 */

/** One attribute of one variant, as the DOM holds it: two strings. */
export interface AttributeDraft {
  name: string;
  value: string;
}

/**
 * One variant. An empty attribute list is the ordinary case — a product sold
 * one way is a single variant with no attributes, which the contract calls the
 * default variant and accepts as `{}`.
 */
export interface VariantDraft {
  attributes: AttributeDraft[];
}

export interface NewProductFormValues {
  name: string;
  description: string;
  variants: VariantDraft[];
}

export interface NewProductFieldErrors {
  name?: MessageKey;
  description?: MessageKey;
  /** Keyed `"variantIndex.attributeIndex"`. */
  attributes?: Record<string, MessageKey>;
  /** Keyed by variant index: this variant repeats an earlier one. */
  variants?: Record<string, MessageKey>;
}

/**
 * A blank form: a nameless product with one variant and no attributes.
 *
 * A function rather than a constant because the value is nested and mutable —
 * a shared object would let one product's variants end up on the next one's
 * form. The simplest product in the shop is therefore a name and nothing else,
 * which is what a fresh installation needs on its first day.
 */
export function emptyNewProduct(): NewProductFormValues {
  return { name: '', description: '', variants: [{ attributes: [] }] };
}

/**
 * An attribute name as the catalog compares them: trimmed and lower-cased.
 *
 * Mirrors `normalizeAttributeName` in
 * `backend/src/modules/catalog/domain/variantSignature.ts`, which is the
 * authority and applies it again on arrival. It is repeated here for one
 * concrete reason rather than for symmetry: attributes cross the wire as a JSON
 * *object*, so two rows typed with the same name collapse into one key in the
 * browser and the server never learns the second existed. Refusing that here is
 * the difference between telling somebody they entered an attribute twice and
 * silently dropping what they typed.
 */
function normalizeAttributeName(name: string): string {
  return name.trim().toLowerCase();
}

/** A row somebody actually filled in. An untouched pair is not an error. */
function isFilled(attribute: AttributeDraft): boolean {
  return attribute.name.trim() !== '' || attribute.value.trim() !== '';
}

/**
 * The form as the person filling it in should be told about it.
 *
 * Immediate feedback and nothing more: the server validates all of this again —
 * with the shared schema and then with its own attribute normalization — and is
 * the authority. What this buys is that a mistake is a sentence under the field
 * rather than a round trip, and that nothing a person typed is quietly lost on
 * the way out.
 */
export function validateNewProductForm(values: NewProductFormValues): NewProductFieldErrors {
  const errors: NewProductFieldErrors = {};
  const attributes: Record<string, MessageKey> = {};
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
      const attributeName = normalizeAttributeName(attribute.name);
      const value = attribute.value.trim();

      if (attributeName === '') {
        attributes[key] = 'catalog.attributeNameRequired';
      } else if (value === '') {
        attributes[key] = 'catalog.attributeValueRequired';
      } else if (seen.has(attributeName)) {
        attributes[key] = 'catalog.duplicateAttribute';
      } else {
        seen.add(attributeName);
        // Identity is case-insensitive on both sides, as the catalog defines it.
        identity.push([attributeName, value.toLowerCase()]);
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

  if (Object.keys(attributes).length > 0) {
    errors.attributes = attributes;
    // A variant with an unusable attribute has no settled identity yet, so
    // reporting it as a duplicate as well would be a second complaint about the
    // same unfinished row.
    return errors;
  }
  if (Object.keys(variants).length > 0) errors.variants = variants;

  return errors;
}

/**
 * The form, as the existing contract wants it.
 *
 * Values are passed through as they were typed — the shared schema trims the
 * product name and the server normalizes attribute names and values on arrival,
 * and doing either of those here as well would mean the browser deciding
 * something the catalog is the authority on. Untouched attribute rows are
 * dropped, which is the one thing this removes and the same rule
 * `validateNewProductForm` skips them by.
 *
 * A blank description is omitted rather than sent as an empty string: the field
 * is optional in the contract, and "not given" is what a shop that did not
 * write one means.
 */
export function toCreateProductRequest(values: NewProductFormValues): CreateProductRequest {
  const description = values.description.trim();

  return {
    name: values.name,
    ...(description === '' ? {} : { description: values.description }),
    /**
     * The temporary form captures no brand and no classification. `brand` is
     * optional and omitted; `classifications` is spelled out empty because the
     * schema defaults it, so the parsed request always carries the object. Both
     * are real states — merchandise nobody has reviewed yet has neither — and
     * neither is guessed from the product name.
     */
    classifications: {},
    variants: values.variants.map((variant) => ({
      attributes: Object.fromEntries(
        variant.attributes
          .filter(isFilled)
          .map((attribute) => [attribute.name, attribute.value] as const),
      ),
      /**
       * No barcodes, no price, no cost either. Price and cost are optional and
       * omitted; `barcodes` is defaulted by the schema, so it is spelled out for
       * the same reason `classifications` is. The merchandise form that captures
       * all of this is PR 7.
       */
      barcodes: [],
    })),
  };
}
