import {
  MAX_MOVEMENT_QUANTITY,
  type InventoryLocation,
  type ListInventoryLocationsResponse,
  type ListProductsResponse,
} from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';

/**
 * The parts of receiving that are decisions rather than markup: which items may
 * be received, how one is named to a person, what a valid form looks like, and
 * how a local date and time becomes an instant.
 *
 * They are here rather than in the screen because each one is a rule somebody
 * may need to check without reading JSX, and because every one of them is worth
 * testing directly. The screen is left with state and layout.
 */

/** One selectable item: a variant, named the way a person would recognize it. */
export interface VariantChoice {
  variantId: string;
  /** Product name, attributes when there are any, and the SKU. */
  label: string;
}

/**
 * The variants stock may be received against, flattened out of the catalog.
 *
 * Both flags matter and for different reasons: an inactive *product* is one the
 * business has retired, and an inactive *variant* is one size or colour of a
 * product still sold. Neither may take new stock, and the server refuses both —
 * offering one here would be offering a choice that fails at the counter.
 *
 * Sorted by label so the list is stable and alphabetical rather than ordered by
 * whenever somebody happened to create each product.
 */
export function activeVariantChoices(products: ListProductsResponse): VariantChoice[] {
  return products
    .filter((product) => product.isActive)
    .flatMap((product) =>
      product.variants
        .filter((variant) => variant.isActive)
        .map((variant) => ({
          variantId: variant.id,
          label: formatVariantLabel(product.name, variant.attributes, variant.sku),
        })),
    )
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/**
 * What a variant is called on screen.
 *
 * ```text
 * Diri — gwosè: 5 mamit, mak: Tchako — EKN-AB12CD34
 * Lwil — EKN-EF56GH78
 * ```
 *
 * The SKU is included because it is the one thing printed on the shelf label,
 * so somebody holding the box can match it. The variant signature, the product
 * id, the variant id, and the timestamps are not: they identify rows to a
 * database and mean nothing to the person receiving a delivery.
 *
 * Attribute names and values are the shop's own words, entered when the product
 * was created, so they are shown as they were typed and are not translated.
 */
export function formatVariantLabel(
  productName: string,
  attributes: ReadonlyArray<{ name: string; value: string }>,
  sku: string,
): string {
  const described = attributes
    .map((attribute) => `${attribute.name}: ${attribute.value}`)
    .join(', ');
  return [productName, described, sku].filter((part) => part !== '').join(' — ');
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

/**
 * A `Date` as `<input type="datetime-local">` wants it: `YYYY-MM-DDTHH:mm`, in
 * the browser's own time zone.
 *
 * Built from the local getters rather than from `toISOString`, which would
 * write UTC into a control the browser reads as local time — and so would show
 * somebody in Haiti a delivery arriving four hours from now.
 */
export function toLocalDateTimeInputValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * The instant a local date and time refers to, as an ISO timestamp — or `null`
 * when the control holds something that is not one.
 *
 * `new Date('2026-08-04T14:30')` is *local* time by specification, which is
 * exactly what the control means, and `toISOString()` then states the same
 * moment in UTC. No time zone is chosen, offered, or guessed at anywhere: the
 * browser's clock is the shop's clock.
 *
 * The round trip at the end is what refuses a date that does not exist.
 * `new Date('2026-02-31T10:00')` does not fail — it rolls forward to 3 March —
 * so a typo would otherwise be sent as a real and wrong business time.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (toLocalDateTimeInputValue(date) !== value.slice(0, 16)) return null;

  return date.toISOString();
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
