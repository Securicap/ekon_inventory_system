import type { AdjustmentReason } from '@ekon/shared';
import {
  canonicalRequestHash,
  type CanonicalValue,
} from '../../../platform/hash/canonicalRequest.js';

/**
 * The canonical form of an adjustment command, and its digest.
 *
 * This is the definition of "the same correction, retried". Two requests hash
 * alike exactly when they say the same seven things, and differ when any one of
 * them changes — which is what lets the posting engine tell a retry from an
 * operation id reused for something else.
 *
 * The generic canonicalization lives in `platform/hash/canonicalRequest.ts` and
 * is not reimplemented here: this file is the *field set*, which is the part a
 * reviewer has to be able to check. Receiving's and removal's equivalents sit
 * beside it, and the three are deliberately separate rather than parameterized
 * — which fields make up a command is each workflow's own statement, and a
 * shared "hash any movement command" helper would be a place for one workflow's
 * fields to quietly become another's.
 */

/**
 * Stamped on the `operations` row as its `operation_type`, and hashed as the
 * `workflow` field.
 *
 * It names the workflow, not the movement type. One command posts either an
 * `ADJUSTMENT_IN` or an `ADJUSTMENT_OUT` depending on the sign of its delta, so
 * a type here would be two names for one command; `inventory.adjust` is the
 * command that was issued. It is also what keeps an adjustment from ever being
 * mistaken for a removal that happened to reuse an operation id — which
 * matters more here than anywhere, because the two can move the same stock in
 * the same direction and mean opposite things.
 */
export const ADJUSTMENT_OPERATION_TYPE = 'inventory.adjust';

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
 * No movement type, because it is derived: the sign of `quantityDelta` decides
 * it, and hashing a value computed from another value in the same hash would
 * add a field that cannot vary independently. It would look like protection and
 * provide none.
 *
 * The **note is in**, unlike in every other workflow here — because it is the
 * only workflow that has one, and because it is a business field rather than
 * decoration. An adjustment whose note changed from "counted wrong" to
 * "delivery never entered" is a different account of what happened, and reusing
 * one operation id across the two is a mistake worth a `409` rather than
 * silently keeping whichever arrived first.
 */
export interface AdjustmentCommandFacts {
  variantId: string;
  locationId: string;
  /**
   * The **signed** correction, exactly as the caller stated it.
   *
   * The one workflow whose hashed quantity carries a sign, because it is the
   * one whose direction the caller chooses rather than the workflow. There is
   * still exactly one representation of any given adjustment, which is what a
   * digest that has to recognize a retry depends on.
   */
  quantityDelta: number;
  /** Why the record needed correcting. The closed vocabulary, never free text. */
  reason: AdjustmentReason;
  /** What was written beside the reason, or `null` when nothing was. */
  note: string | null;
  /**
   * Already normalized to an instant. Passing a `Date` rather than the string
   * off the wire is what makes `10:00:00-05:00` and `15:00:00.000Z` the same
   * command: both arrive here as one instant and are serialized one way.
   */
  occurredAt: Date;
  /** The authenticated session's user. Never a value from the request body. */
  actorId: string;
}

export function adjustmentRequestHash(facts: AdjustmentCommandFacts): string {
  return canonicalRequestHash(adjustmentCanonicalFields(facts));
}

/** The canonical field set, exported so the hash's inputs are testable directly. */
export function adjustmentCanonicalFields(
  facts: AdjustmentCommandFacts,
): Readonly<Record<string, CanonicalValue>> {
  return {
    workflow: ADJUSTMENT_OPERATION_TYPE,
    variantId: facts.variantId,
    locationId: facts.locationId,
    quantityDelta: facts.quantityDelta,
    reason: facts.reason,
    note: facts.note,
    occurredAt: facts.occurredAt.toISOString(),
    actorId: facts.actorId,
  };
}
