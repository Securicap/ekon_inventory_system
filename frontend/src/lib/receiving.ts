import {
  MAX_MOVEMENT_QUANTITY,
  type InventoryLocation,
  type ListInventoryLocationsResponse,
  type ListProductsResponse,
} from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';
import { localDateTimeToIso } from './businessTime.js';
import { formatVariantAttributes, formatVariantLabel } from './variants.js';

/**
 * The parts of receiving that are decisions rather than markup: which items may
 * be received, which counter a fresh form starts on, and what a valid form
 * looks like.
 *
 * They are here rather than in the screen because each one is a rule somebody
 * may need to check without reading JSX, and because every one of them is worth
 * testing directly. The screen is left with state and layout.
 *
 * Two things receiving used to own have moved out, because removal needs them
 * and the two workflows must not describe the same variant or round the same
 * local time differently: variant labels are `lib/variants.ts`, and business
 * time is `lib/businessTime.ts`.
 */

/** One selectable item: a variant, named the way a person would recognize it. */
export interface VariantChoice {
  variantId: string;
  /** Product name, attributes when there are any, and the SKU. */
  label: string;
  /**
   * The same three facts kept apart, for the places that show the hierarchy
   * rather than one line: a product name above its attributes above its SKU.
   *
   * Derived from the label's own parts rather than re-read from the catalog, so
   * an option and the panel beside it can never disagree about what was chosen.
   */
  productName: string;
  /** Formatted attributes, or an empty string for a product sold one way. */
  attributes: string;
  sku: string;
}

/**
 * The variants stock may be received against, flattened out of the catalog.
 *
 * **Receiving needs `ACTIVE` at both levels, and nothing weaker.**
 * `DISCONTINUED` merchandise is merchandise the business decided to stop
 * buying: its remaining stock is still sold and still counted, but a delivery
 * of it is refused by the server, so offering it here would be offering a
 * choice that fails at the counter. `ARCHIVED` is out of operation entirely.
 *
 * Both levels are checked because they are different facts: a withdrawn
 * *product* is a line the shop has stopped, and a withdrawn *variant* is one
 * size or colour of a product it still sells. The server combines them the same
 * way — a variant is never more available than its product — and refuses either.
 *
 * Sorted by label so the list is stable and alphabetical rather than ordered by
 * whenever somebody happened to create each product.
 */
export function activeVariantChoices(products: ListProductsResponse): VariantChoice[] {
  return products
    .filter((product) => product.lifecycleStatus === 'ACTIVE')
    .flatMap((product) =>
      product.variants
        .filter((variant) => variant.lifecycleStatus === 'ACTIVE')
        .map((variant) => ({
          variantId: variant.id,
          label: formatVariantLabel(product.name, variant.attributes, variant.sku),
          productName: product.name,
          attributes: formatVariantAttributes(variant.attributes),
          sku: variant.sku,
        })),
    )
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/** Locations that may take stock. An inactive location is not a choice. */
export function activeLocations(locations: ListInventoryLocationsResponse): InventoryLocation[] {
  return locations.filter((location) => location.isActive);
}

/**
 * Which location a fresh form should start on.
 *
 * The default location when there is one, because that is where deliveries
 * arrive in a shop that has only ever had one counter. Failing that, the only
 * active location, because a list of one is not a choice worth making somebody
 * make. Otherwise nothing: with several real options, guessing would be a guess
 * the person has to notice and undo.
 */
export function preferredLocationId(locations: readonly InventoryLocation[]): string | null {
  const preferred = locations.find((location) => location.isDefault) ?? locations[0];
  if (!preferred) return null;
  if (preferred.isDefault) return preferred.id;
  return locations.length === 1 ? preferred.id : null;
}

/** What the form holds while it is being filled in. Strings, as the DOM has them. */
export interface ReceivingFormValues {
  variantId: string;
  locationId: string;
  quantity: string;
  occurredAtLocal: string;
}

export type ReceivingFieldErrors = Partial<Record<keyof ReceivingFormValues, MessageKey>>;

/**
 * The form as the person filling it in should be told about it.
 *
 * Immediate feedback, and nothing more: the server validates all of this again
 * and is the authority. What this buys is that an obvious mistake is a sentence
 * under the field rather than a round trip and a red box — and that a receipt
 * which could only be refused never consumes an operation id.
 */
export function validateReceivingForm(values: ReceivingFormValues): ReceivingFieldErrors {
  const errors: ReceivingFieldErrors = {};

  if (values.variantId === '') errors.variantId = 'receiving.variantRequired';
  if (values.locationId === '') errors.locationId = 'receiving.locationRequired';

  const quantity = values.quantity.trim();
  if (quantity === '') {
    errors.quantity = 'receiving.quantityRequired';
  } else {
    const parsed = Number(quantity);
    // Whole units only, and never zero or negative. A fraction of a sack of
    // rice is not a quantity this ledger can hold, and a receipt that removes
    // stock is not a receipt.
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errors.quantity = 'receiving.quantityInvalid';
    } else if (parsed > MAX_MOVEMENT_QUANTITY) {
      errors.quantity = 'receiving.quantityTooLarge';
    }
  }

  if (values.occurredAtLocal.trim() === '') {
    errors.occurredAtLocal = 'receiving.occurredAtRequired';
  } else if (localDateTimeToIso(values.occurredAtLocal) === null) {
    errors.occurredAtLocal = 'receiving.occurredAtInvalid';
  }

  return errors;
}
