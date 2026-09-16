import type { InventoryMovementRecord, MovementType } from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';

/**
 * Turning the ledger's own words into the shop's.
 *
 * `RECEIPT`, `ISSUE`, `ADJUSTMENT_OUT`, `SOLD` — these are stable machine
 * values, permanent in an append-only table, and they are what the API sends
 * and receives. They are not what anybody at a counter should read.
 *
 * The translation happens here, once, on the way to the screen and never on the
 * way back. Nothing in this file is ever sent to the server: a reason chosen
 * from a list goes back as the code it always was, and a movement type is never
 * sent at all because the server derives every one of them.
 */

/**
 * What a movement type is called on screen.
 *
 * Deliberately exhaustive over `MovementType` rather than a lookup with a
 * fallback: adding a type to the vocabulary should fail to compile here until
 * somebody decides what a shop calls it, which is the same friction the posting
 * engine applies to the sign of a new type.
 */
const MOVEMENT_TYPE_KEYS: Readonly<Record<MovementType, MessageKey>> = {
  RECEIPT: 'movement.receipt',
  ISSUE: 'movement.issue',
  ADJUSTMENT_IN: 'movement.adjustmentIn',
  ADJUSTMENT_OUT: 'movement.adjustmentOut',
  COUNT_RECONCILIATION: 'movement.countReconciliation',
  REVERSAL: 'movement.reversal',
};

export function movementTypeKey(type: MovementType): MessageKey {
  return MOVEMENT_TYPE_KEYS[type];
}

/**
 * The reason codes any movement can carry, in one table.
 *
 * Three vocabularies live in the ledger's one `reason_code` column — removal's,
 * adjustment's, and count reconciliation's — and history reads all three
 * without knowing which workflow wrote the row. So they are translated
 * together, keyed by the string as stored.
 *
 * `DATA_ENTRY_ERROR` and `OTHER` appear in two vocabularies each and mean the
 * same thing in both, which is why one entry serves them. Anything unknown
 * falls back to the code itself: a reason this build has never heard of is
 * still evidence, and showing `SPOILED` is far better than showing nothing or
 * pretending it was something else.
 */
const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  // Removal — why stock physically left.
  SOLD: 'reason.sold',
  DAMAGED: 'reason.damaged',
  INTERNAL_USE: 'reason.internalUse',
  // Adjustment — why the recorded number was wrong.
  DATA_ENTRY_ERROR: 'reason.dataEntryError',
  MISSED_MOVEMENT: 'reason.missedMovement',
  // Count reconciliation — why a difference was accepted.
  UNRECORDED_SALE: 'reason.unrecordedSale',
  MISSED_RECEIPT: 'reason.missedReceipt',
  MISPLACED_STOCK: 'reason.misplacedStock',
  SHRINKAGE: 'reason.shrinkage',
  OTHER: 'reason.other',
};

/** `null` when the movement carries no reason, which receipts and reversals do not. */
export function reasonKey(reasonCode: string | null): MessageKey | null {
  if (reasonCode === null) return null;
  return REASON_KEYS[reasonCode] ?? null;
}

/**
 * What to put in front of somebody scanning a history feed.
 *
 * An `ISSUE` reads as **Sold** rather than as "Stock removed", because the
 * reason is the business fact and the type is the mechanism — sold, broken and
 * taken for the shop's own use are three different things, and a feed that
 * collapsed them into one phrase would be hiding exactly the distinction the
 * ledger keeps a reason column for.
 *
 * Everything else leads with its type. An adjustment's reason explains a
 * correction rather than naming an event, and a reconciliation's names a
 * conclusion — both belong beside the movement, not instead of it.
 */
export function movementHeadlineKey(movement: InventoryMovementRecord): MessageKey {
  if (movement.movementType === 'ISSUE') {
    const reason = reasonKey(movement.reasonCode);
    if (reason !== null) return reason;
  }
  return movementTypeKey(movement.movementType);
}

/** `+4` / `−1`, with a real minus sign rather than a hyphen. */
export function formatDelta(quantityDelta: number): string {
  return quantityDelta > 0 ? `+${quantityDelta}` : `−${Math.abs(quantityDelta)}`;
}

/**
 * Whether a movement can be reversed at all, before anybody is offered the
 * action.
 *
 * Two rules, both the ledger's own (INV-2): a `REVERSAL` may not itself be
 * reversed, and a movement that has already been reversed may not be reversed
 * again. The server refuses either with a `409`, which is the boundary that
 * matters; this decides whether to draw a button that would be refused.
 *
 * It deliberately does **not** try to predict the stock floor. Whether
 * reversing a receipt would take the shelf below zero depends on the current
 * balance, which this screen does not have and must not guess at — that refusal
 * belongs to the server and is rendered when it comes back.
 */
export function isReversible(movement: InventoryMovementRecord): boolean {
  return movement.movementType !== 'REVERSAL' && movement.reversedByMovementId === null;
}
