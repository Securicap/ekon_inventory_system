import {
  MAX_MOVEMENT_QUANTITY,
  type CountReconciliationReason,
  type CountRecord,
  type CountStatus,
} from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';

/**
 * Physical counts: the parts that are decisions rather than markup.
 *
 * One sentence governs every one of them, and it is worth writing where the
 * code is rather than only in a README:
 *
 * > **A count observes. Investigation explains. Reconciliation changes stock.**
 *
 * So nothing in this file computes a new balance, and nothing turns a variance
 * into a decision. The variance is arithmetic the server already did and stored
 * permanently; the delta a reconciliation posts is that same number, and the
 * screen's job is to say what it will do before somebody agrees to it.
 */

export const COUNT_STATUS_KEYS: Readonly<Record<CountStatus, MessageKey>> = {
  MATCHED: 'counts.statusMatched',
  OPEN: 'counts.statusOpen',
  RECONCILED: 'counts.statusReconciled',
};

/**
 * What a shop calls each reason for accepting a difference.
 *
 * Seven conclusions an investigation can actually reach. There is deliberately
 * no entry for "the count was wrong", because the vocabulary has none: a
 * mistaken count is corrected by counting again, not by accepting a difference
 * nobody believes in.
 */
export const COUNT_REASON_KEYS: Readonly<Record<CountReconciliationReason, MessageKey>> = {
  UNRECORDED_SALE: 'reason.unrecordedSale',
  MISSED_RECEIPT: 'reason.missedReceipt',
  DAMAGED: 'reason.damaged',
  MISPLACED_STOCK: 'reason.misplacedStock',
  SHRINKAGE: 'reason.shrinkage',
  DATA_ENTRY_ERROR: 'reason.dataEntryError',
  OTHER: 'reason.other',
};

export interface RecordCountFormValues {
  variantId: string;
  locationId: string;
  /** What is physically on the shelf, as typed. Zero is a real answer. */
  countedQuantity: string;
  countedAtLocal: string;
}

export interface RecordCountFieldErrors {
  variantId?: MessageKey;
  locationId?: MessageKey;
  countedQuantity?: MessageKey;
  countedAtLocal?: MessageKey;
}

export function emptyCount(countedAtLocal: string): RecordCountFormValues {
  return { variantId: '', locationId: '', countedQuantity: '', countedAtLocal };
}

/**
 * The count form, as the person filling it in should be told about it.
 *
 * **Zero is valid and is not an empty field.** An empty shelf is exactly the
 * observation somebody most needs to record, and a form that refused it would
 * be refusing the count that matters most.
 *
 * There is nothing here about the expected quantity, and there cannot be: the
 * server reads it inside the recording transaction and this form never sees it.
 * That is the point — a count states what was seen, and comparing is the
 * server's job afterwards.
 */
export function validateCountForm(values: RecordCountFormValues): RecordCountFieldErrors {
  const errors: RecordCountFieldErrors = {};

  if (values.variantId === '') errors.variantId = 'counts.itemRequired';
  if (values.locationId === '') errors.locationId = 'counts.locationRequired';

  const counted = Number(values.countedQuantity);
  if (values.countedQuantity.trim() === '') {
    errors.countedQuantity = 'counts.quantityRequired';
  } else if (!Number.isInteger(counted) || counted < 0) {
    errors.countedQuantity = 'counts.quantityInvalid';
  } else if (counted > MAX_MOVEMENT_QUANTITY) {
    errors.countedQuantity = 'counts.quantityTooLarge';
  }

  if (values.countedAtLocal.trim() === '') errors.countedAtLocal = 'counts.timeRequired';

  return errors;
}

export interface ReconcileFormValues {
  reason: CountReconciliationReason | '';
  note: string;
}

export interface ReconcileFieldErrors {
  reason?: MessageKey;
  note?: MessageKey;
}

export function validateReconcileForm(values: ReconcileFormValues): ReconcileFieldErrors {
  const errors: ReconcileFieldErrors = {};
  if (values.reason === '') errors.reason = 'counts.reasonRequired';
  if (values.reason === 'OTHER' && values.note.trim() === '') errors.note = 'counts.noteRequired';
  return errors;
}

/**
 * The sentence a reconciliation has to say before anybody agrees to it.
 *
 * It names the **change**, never the destination: *this will adjust inventory
 * by −1*, not *this will set inventory to 6*. The second is what a reader
 * assumes and it is arithmetically wrong the moment anything else moved the
 * shelf after the count — six was true when the shelf was walked, and if a unit
 * sold since then the answer is five. Telling somebody the wrong number and
 * then quietly posting the right one is how a system loses their trust exactly
 * once.
 */
export function reconciliationMessageKey(count: CountRecord): MessageKey {
  return count.variance > 0 ? 'counts.willIncrease' : 'counts.willDecrease';
}

/** `+2` / `−1`, with a real minus sign. Zero is shown plainly: it is a match. */
export function formatVariance(variance: number): string {
  if (variance === 0) return '0';
  return variance > 0 ? `+${variance}` : `−${Math.abs(variance)}`;
}
