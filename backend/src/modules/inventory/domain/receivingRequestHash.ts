import {
  canonicalRequestHash,
  type CanonicalValue,
} from '../../../platform/hash/canonicalRequest.js';

/**
 * The canonical form of a receiving command, and its digest.
 *
 * This is the definition of "the same delivery, retried". Two requests hash
 * alike exactly when they say the same six things, and differ when any one of
 * them changes — which is what lets the posting engine tell a retry from an
 * operation id reused for something else.
 */

/**
 * Stamped on the `operations` row as its `operation_type`, and hashed as the
 * `workflow` field.
 *
 * It names the workflow, not the movement type. `RECEIPT` is how the ledger
 * records what happened; `inventory.receive` is the command that asked for it,
 * and a later workflow that also posts receipts — an opening stock load, say —
 * would be a different command with the same movement type. Hashing the
 * workflow keeps those apart under one operation id.
 */
export const RECEIVING_OPERATION_TYPE = 'inventory.receive';

/**
 * Everything the digest covers, and nothing else.
 *
 * Note what is not here. No movement id, no recorded time, no quantity before
 * or after, no predecessor movement: those are the ledger's answer to this
 * command, and hashing an answer would make every retry look like a different
 * question. No operation id either — the id is what the hash is stored
 * *against*, so including it would make every command hash uniquely and the
 * comparison would never fail, which is the same as not comparing at all.
 *
 * `actorId` is in, because who received stock is part of what happened. The
 * same delivery booked in by a different person is a different business fact,
 * and reusing an operation id across two people is a mistake worth refusing
 * rather than silently attributing to whoever got there first.
 */
export interface ReceivingCommandFacts {
  variantId: string;
  locationId: string;
  quantity: number;
  /**
   * Already normalized to an instant. Passing a `Date` rather than the string
   * off the wire is what makes `10:00:00-05:00` and `15:00:00.000Z` the same
   * command: both arrive here as one instant and are serialized one way.
   */
  occurredAt: Date;
  /** The authenticated session's user. Never a value from the request body. */
  actorId: string;
}

export function receivingRequestHash(facts: ReceivingCommandFacts): string {
  return canonicalRequestHash(receivingCanonicalFields(facts));
}

/** The canonical field set, exported so the hash's inputs are testable directly. */
export function receivingCanonicalFields(
  facts: ReceivingCommandFacts,
): Readonly<Record<string, CanonicalValue>> {
  return {
    workflow: RECEIVING_OPERATION_TYPE,
    variantId: facts.variantId,
    locationId: facts.locationId,
    quantity: facts.quantity,
    occurredAt: facts.occurredAt.toISOString(),
    actorId: facts.actorId,
  };
}
