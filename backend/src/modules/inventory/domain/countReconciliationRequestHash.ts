import type { CountReconciliationReason } from '@ekon/shared';
import {
  canonicalRequestHash,
  type CanonicalValue,
} from '../../../platform/hash/canonicalRequest.js';

/**
 * The canonical form of a reconciliation decision, and its digest.
 *
 * This is the definition of "the same acceptance, retried". A reconciliation
 * moves stock, so it carries the same weight as any other posting command: a
 * retry must settle the discrepancy once, and an operation id reused for a
 * different decision must be refused rather than resolved by arrival order.
 */

/**
 * Stamped on the `operations` row as its `operation_type`, and hashed as the
 * `workflow` field.
 *
 * It names the workflow, not the movement type. `COUNT_RECONCILIATION` is how
 * the ledger records what happened; `inventory.count.reconcile` is the command
 * that asked for it — and keeping them apart is what stops an operation id
 * reused across an adjustment and a reconciliation from being answered with
 * either one's result.
 */
export const COUNT_RECONCILE_OPERATION_TYPE = 'inventory.count.reconcile';

/**
 * Everything the digest covers, and nothing else.
 *
 * **The field set is short because the decision is short.** No variant, no
 * location, no quantity, no delta: every one of them comes from the persisted
 * count, so hashing them would hash values the caller never sent and could not
 * vary. `countId` already identifies all of them, and two reconcile requests
 * naming the same count with the same reason and the same note *are* the same
 * decision — which is exactly what this digest has to be able to say.
 *
 * The **note is in it**, for the reason an adjustment's is: it is the
 * reconciler's account of what the investigation found, and two different
 * accounts under one operation id is a mistake worth a `409` rather than
 * silently keeping whichever arrived first.
 *
 * There is no `occurredAt` to hash. The movement's business time is the count's
 * own `countedAt` — the discrepancy existed when the shelf was walked, and
 * accepting it later is a decision about that past observation rather than a
 * new event on the shelf.
 */
export interface CountReconciliationCommandFacts {
  /** The count being settled. The whole of what is being decided about. */
  countId: string;
  /** Why the discrepancy was accepted. The closed vocabulary, never free text. */
  reason: CountReconciliationReason;
  /** What the investigation found, or `null` when nothing was written. */
  note: string | null;
  /** The authenticated session's user. Never a value from the request body. */
  actorId: string;
}

export function countReconciliationRequestHash(facts: CountReconciliationCommandFacts): string {
  return canonicalRequestHash(countReconciliationCanonicalFields(facts));
}

/** The canonical field set, exported so the hash's inputs are testable directly. */
export function countReconciliationCanonicalFields(
  facts: CountReconciliationCommandFacts,
): Readonly<Record<string, CanonicalValue>> {
  return {
    workflow: COUNT_RECONCILE_OPERATION_TYPE,
    countId: facts.countId,
    reason: facts.reason,
    note: facts.note,
    actorId: facts.actorId,
  };
}
