import { MAX_MOVEMENT_QUANTITY, type AdjustmentReason } from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';

/**
 * Correcting a recorded quantity: the parts that are decisions rather than
 * markup.
 *
 * The contract takes a **signed** `quantityDelta` — `-2` to say the shelf holds
 * two fewer than Ekon thinks. That is the right shape for a ledger command and
 * the wrong shape for a form: somebody at a counter should not have to know
 * that a minus sign is how you say "we have fewer than it says".
 *
 * So the form asks two ordinary questions — *which way* and *how many* — and
 * this turns the pair into the number the contract wants. Exactly one place
 * knows that `Decrease` means a negative delta, and it is here rather than in a
 * component.
 */

/** Which way the record was wrong, as a person would say it. */
export type AdjustmentDirection = 'increase' | 'decrease';

export const ADJUSTMENT_DIRECTION_KEYS: Readonly<Record<AdjustmentDirection, MessageKey>> = {
  increase: 'adjust.directionIncrease',
  decrease: 'adjust.directionDecrease',
};

/**
 * What a shop calls each adjustment reason.
 *
 * `MISSED_MOVEMENT` and `DATA_ENTRY_ERROR` are the two real causes of a wrong
 * number, and `OTHER` is the honest escape — which is why it demands a note.
 * The codes themselves never change: these are display strings and nothing
 * more.
 */
export const ADJUSTMENT_REASON_KEYS: Readonly<Record<AdjustmentReason, MessageKey>> = {
  DATA_ENTRY_ERROR: 'reason.dataEntryError',
  MISSED_MOVEMENT: 'reason.missedMovement',
  OTHER: 'reason.other',
};

export interface AdjustmentFormValues {
  direction: AdjustmentDirection;
  /** The magnitude, as typed. Always positive; the direction carries the sign. */
  quantity: string;
  reason: AdjustmentReason | '';
  note: string;
  occurredAtLocal: string;
}

export interface AdjustmentFieldErrors {
  quantity?: MessageKey;
  reason?: MessageKey;
  note?: MessageKey;
  occurredAtLocal?: MessageKey;
}

export function emptyAdjustment(occurredAtLocal: string): AdjustmentFormValues {
  return { direction: 'decrease', quantity: '', reason: '', note: '', occurredAtLocal };
}

/**
 * The signed delta the contract wants, from the two things the form asked.
 *
 * `null` when the magnitude is not a usable whole number — the caller has
 * already been told so by `validateAdjustmentForm`, and this refuses to invent
 * a delta from an unusable field rather than sending a `NaN` to the server.
 */
export function toQuantityDelta(values: AdjustmentFormValues): number | null {
  const magnitude = Number(values.quantity);
  if (!Number.isInteger(magnitude) || magnitude <= 0) return null;
  return values.direction === 'increase' ? magnitude : -magnitude;
}

/**
 * The form as the person filling it in should be told about it.
 *
 * Immediate feedback and nothing more. The server validates all of this again
 * against the shared schema and is the authority — including the one rule this
 * cannot check at all: whether the shelf can absorb a decrease. That is the
 * stock floor, it depends on a balance this form does not hold, and it comes
 * back as `INSUFFICIENT_STOCK`.
 */
export function validateAdjustmentForm(values: AdjustmentFormValues): AdjustmentFieldErrors {
  const errors: AdjustmentFieldErrors = {};

  const quantity = Number(values.quantity);
  if (values.quantity.trim() === '') {
    errors.quantity = 'adjust.quantityRequired';
  } else if (!Number.isInteger(quantity) || quantity <= 0) {
    // Zero is refused here rather than at the server's `quantityDelta` check,
    // because "correct it by nothing" is a form somebody has not finished
    // filling in rather than a command worth sending.
    errors.quantity = 'adjust.quantityInvalid';
  } else if (quantity > MAX_MOVEMENT_QUANTITY) {
    errors.quantity = 'adjust.quantityTooLarge';
  }

  if (values.reason === '') errors.reason = 'adjust.reasonRequired';

  // The one field rule the contract enforces itself: `OTHER` says nothing on
  // its own, so it says it in the note or it is not recorded.
  if (values.reason === 'OTHER' && values.note.trim() === '') errors.note = 'adjust.noteRequired';

  if (values.occurredAtLocal.trim() === '') errors.occurredAtLocal = 'adjust.timeRequired';

  return errors;
}
