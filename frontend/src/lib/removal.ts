import {
  MAX_MOVEMENT_QUANTITY,
  REMOVAL_REASONS,
  type ListInventoryBalancesResponse,
  type RemovalReason,
} from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';
import { ApiError } from './api.js';
import { localDateTimeToIso } from './businessTime.js';
import { formatVariantLabel } from './variants.js';

/**
 * The parts of stock removal that are decisions rather than markup: what may be
 * taken off a shelf, which shelf a fresh form starts on, and what a valid form
 * looks like.
 *
 * They are here rather than in the screen because each one is a rule somebody
 * may need to check without reading JSX, and because every one of them is worth
 * testing directly. The screen is left with state and layout.
 *
 * **Everything on this page is advisory.** The quantities come from the last
 * balance read, and somebody else at the counter may take the last two bottles
 * between that read and this submission. The server decides, under the row lock
 * it already holds, and it can still answer `INSUFFICIENT_STOCK` for a removal
 * this file thought was fine. What these rules buy is that an obvious mistake
 * is a sentence under a field rather than a round trip — and that a removal
 * which could only be refused never consumes an operation id.
 */

/** One shelf a variant sits on, as the removal form offers it. */
export interface RemovableLocationChoice {
  locationId: string;
  locationName: string;
  isDefault: boolean;
  /** Quantity on hand as of the last balance read. Advisory, never a promise. */
  quantity: number;
}

/** One selectable item, named the way a person would recognize it. */
export interface RemovableVariantChoice {
  variantId: string;
  /** Product name, attributes when there are any, and the SKU. */
  label: string;
  /** Across every active location. Zero means nothing can be removed anywhere. */
  totalQuantity: number;
  /** Every active location the server returned for this variant, in its order. */
  locations: RemovableLocationChoice[];
}

/**
 * The removal choices, flattened out of the balance response.
 *
 * **The balance read is the whole source.** It already carries the product
 * name, the SKU, the attributes, and every active location with its name and
 * its quantity — which is exactly the question this screen asks: *which shelf
 * am I taking from, and how many are there now?* Reading the catalog and the
 * location list separately would be two more requests on a bad connection, and
 * three chances for the pieces to disagree about which shelf holds what.
 *
 * Nothing is filtered out and nothing is re-sorted. The server's order is
 * deterministic and is the same order the stock screen shows, so an employee
 * who has just looked at Stock finds the item in the same place here. Variants
 * holding nothing stay in the list and are refused as *choices* by the screen —
 * dropping them would make a shop that is out of rice look like a shop that
 * never sold rice.
 */
export function removableVariantChoices(
  balances: ListInventoryBalancesResponse,
): RemovableVariantChoice[] {
  return balances.map((variant) => ({
    variantId: variant.variantId,
    label: formatVariantLabel(variant.productName, variant.attributes, variant.sku),
    totalQuantity: variant.totalQuantity,
    locations: variant.locations.map((location) => ({
      locationId: location.locationId,
      locationName: location.locationName,
      isDefault: location.isDefault,
      quantity: location.quantity,
    })),
  }));
}

/** The shelves the chosen variant sits on. Empty when nothing is chosen. */
export function locationsForVariant(
  choices: readonly RemovableVariantChoice[],
  variantId: string,
): RemovableLocationChoice[] {
  return choices.find((choice) => choice.variantId === variantId)?.locations ?? [];
}

/**
 * Whether stock can be removed from a variant at all.
 *
 * A variant whose every location is zero cannot succeed anywhere, so offering
 * it as a choice would be offering a guaranteed refusal — a round trip, a red
 * box, and a consumed operation id, to be told what the screen already knew.
 */
export function isRemovable(choice: RemovableVariantChoice): boolean {
  return choice.totalQuantity > 0;
}

/** Whether one shelf can be removed from. Zero is visible, never selectable. */
export function isRemovableLocation(location: RemovableLocationChoice): boolean {
  return location.quantity > 0;
}

/**
 * Which shelf a fresh form should start on, once an item is chosen.
 *
 * The default location when it actually holds something, because that is where
 * a single-counter shop takes stock from. Failing that, the only shelf with
 * stock, because a list of one is not a choice worth making somebody make.
 * Otherwise nothing: with several real options, guessing would be a guess the
 * person has to notice and undo — and this is a form that takes stock away.
 *
 * **A default location holding zero is never preselected.** It is the one
 * plausible-looking wrong answer here: the form would open on a shelf that
 * cannot satisfy any quantity, and the employee would find that out from the
 * server.
 */
export function preferredRemovalLocationId(
  locations: readonly RemovableLocationChoice[],
): string | null {
  const stocked = locations.filter(isRemovableLocation);
  const preferred = stocked.find((location) => location.isDefault);
  if (preferred) return preferred.locationId;
  return stocked.length === 1 ? stocked[0]!.locationId : null;
}

/** What one shelf holds as of the last read, or `null` when none is chosen. */
export function quantityAt(
  locations: readonly RemovableLocationChoice[],
  locationId: string,
): number | null {
  return locations.find((location) => location.locationId === locationId)?.quantity ?? null;
}

/** The translated name of each reason. The codes never reach a screen. */
export const REMOVAL_REASON_LABEL_KEYS: Readonly<Record<RemovalReason, MessageKey>> = {
  SOLD: 'removal.reasonSold',
  DAMAGED: 'removal.reasonDamaged',
  INTERNAL_USE: 'removal.reasonInternalUse',
  OTHER: 'removal.reasonOther',
};

/** Whether a string off a `<select>` is one of the reasons the server accepts. */
export function isRemovalReason(value: string): value is RemovalReason {
  return (REMOVAL_REASONS as readonly string[]).includes(value);
}

/** What the form holds while it is being filled in. Strings, as the DOM has them. */
export interface RemovalFormValues {
  variantId: string;
  locationId: string;
  quantity: string;
  reason: string;
  occurredAtLocal: string;
}

export type RemovalFieldErrors = Partial<Record<keyof RemovalFormValues, MessageKey>>;

/**
 * The form as the person filling it in should be told about it.
 *
 * `availableQuantity` is what the last balance read said the chosen shelf
 * holds, or `null` when no shelf is chosen yet. Comparing against it catches
 * the common mistake — asking for more than is there — before a request is
 * sent. It is **not** a guarantee: the number can be stale by the time the
 * request lands, which is why the server keeps the authority and why a `422`
 * remains a state this screen renders rather than a case it prevents.
 */
export function validateRemovalForm(
  values: RemovalFormValues,
  context: { availableQuantity: number | null },
): RemovalFieldErrors {
  const errors: RemovalFieldErrors = {};

  if (values.variantId === '') errors.variantId = 'removal.variantRequired';
  if (values.locationId === '') errors.locationId = 'removal.locationRequired';

  const quantity = values.quantity.trim();
  if (quantity === '') {
    errors.quantity = 'removal.quantityRequired';
  } else {
    const parsed = Number(quantity);
    // Whole units only, and never zero or negative. A fraction of a sack of
    // rice is not a quantity this ledger can hold, and a removal of minus three
    // is a receipt wearing the wrong form.
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errors.quantity = 'removal.quantityInvalid';
    } else if (parsed > MAX_MOVEMENT_QUANTITY) {
      errors.quantity = 'removal.quantityTooLarge';
    } else if (context.availableQuantity !== null && parsed > context.availableQuantity) {
      // Advisory, and worth saying anyway: the shelf as we last read it cannot
      // cover this. Never clamped, never silently reduced, and never answered
      // by quietly choosing a different shelf — the employee decides what to
      // do, because only they know what is physically in front of them.
      errors.quantity = 'removal.quantityExceedsStock';
    }
  }

  if (values.reason === '') {
    errors.reason = 'removal.reasonRequired';
  } else if (!isRemovalReason(values.reason)) {
    errors.reason = 'removal.reasonInvalid';
  }

  if (values.occurredAtLocal.trim() === '') {
    errors.occurredAtLocal = 'removal.occurredAtRequired';
  } else if (localDateTimeToIso(values.occurredAtLocal) === null) {
    errors.occurredAtLocal = 'removal.occurredAtInvalid';
  }

  return errors;
}

/**
 * Whether sending the identical command again could plausibly succeed.
 *
 * A dropped connection and a server fault are both "we do not know whether that
 * worked", and the operation id is what makes asking again safe. Everything
 * else is the server stating something true that a second identical request
 * will not change — including `INSUFFICIENT_STOCK`, which is the one worth
 * naming: it is a **definitive** refusal, the transaction rolled back, and the
 * stock did not move. Offering "send it again" there would invite somebody to
 * hammer a button that cannot work until the command itself changes.
 */
export function canRetryRemoval(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500;
  // Anything that is not an answer from the server — a dropped connection,
  // most of all — is an unknown outcome, and an unknown outcome is what the
  // operation id exists for.
  return !(error instanceof ApiError);
}

/**
 * Whether a failure means the quantities on this screen are out of date.
 *
 * Three failures say so, each in its own words: the shelf did not hold enough,
 * the item or location no longer exists, or it is no longer active. All three
 * are the server describing a world that has moved since the last balance read,
 * so the honest next step is to go and read it again — before the employee
 * decides what to do, rather than after they have guessed.
 *
 * A dropped connection is deliberately not here. Nothing is known to have
 * changed, the retry is still the right move, and refetching mid-retry would
 * show a number that may be about to change again.
 */
export function balancesAreStaleAfter(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    error.code === 'INSUFFICIENT_STOCK' || error.code === 'NOT_FOUND' || error.code === 'CONFLICT'
  );
}

/** Whether the server definitively refused for want of stock. */
export function isInsufficientStock(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'INSUFFICIENT_STOCK';
}
