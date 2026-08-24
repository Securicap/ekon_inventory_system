import {
  canonicalRequestHash,
  type CanonicalValue,
} from '../../../platform/hash/canonicalRequest.js';

/**
 * The canonical form of a count observation, and its digest.
 *
 * This is the definition of "the same shelf-check, retried". Recording a count
 * moves no stock, so it is tempting to think a duplicate is harmless — it is
 * not. A count is durable business evidence, and two records of one shelf-check
 * would show as two observations of the same moment, each with its own
 * variance, either of which somebody could reconcile. The second reconciliation
 * would move stock for a discrepancy that was only ever observed once.
 *
 * So a retried observation is recognized exactly as a retried stock command is,
 * through the same `operations` mechanism (INV-7). The field set is the part a
 * reviewer has to be able to check, and it is here.
 */

/**
 * Stamped on the `operations` row as its `operation_type`, and hashed as the
 * `workflow` field.
 *
 * Its result pointer is a count line rather than a movement, which is the first
 * time an operation has produced anything else. That is what the type keeps
 * straight: an id reused across a count and a receipt is refused before either
 * can be answered with the other's result.
 */
export const COUNT_RECORD_OPERATION_TYPE = 'inventory.count.record';

/**
 * Everything the digest covers, and nothing else.
 *
 * **`expectedQuantity` is deliberately absent**, and it is the most important
 * absence here. The expected quantity is not part of the command — the caller
 * never states it, the server reads it from the balance projection inside the
 * transaction, and it can legitimately differ between an attempt and its retry
 * because the shop kept trading in between. Hashing it would make a genuine
 * retry look like a different command precisely when a receipt had landed
 * between the two attempts, and the person at the shelf would be told their
 * count conflicted with itself.
 *
 * Neither is the count line's id, the recorded time, or the variance: those are
 * the system's answer to this command, and hashing an answer would make every
 * retry differ from the attempt it repeats. No operation id either — the id is
 * what the hash is stored *against*.
 *
 * `actorId` is in, because who walked the shelf is part of what happened. The
 * same shelf counted to the same number by two different people on the same
 * morning is two observations, and an operation id reused across them is a
 * mistake worth refusing rather than silently attributing to whoever got there
 * first.
 */
export interface CountCommandFacts {
  variantId: string;
  locationId: string;
  /** What was physically there. Zero is a real observation. */
  countedQuantity: number;
  /**
   * Already normalized to an instant. Passing a `Date` rather than the string
   * off the wire is what makes `10:00:00-05:00` and `15:00:00.000Z` the same
   * command: both arrive here as one instant and are serialized one way.
   */
  countedAt: Date;
  /** The authenticated session's user. Never a value from the request body. */
  actorId: string;
}

export function countRequestHash(facts: CountCommandFacts): string {
  return canonicalRequestHash(countCanonicalFields(facts));
}

/** The canonical field set, exported so the hash's inputs are testable directly. */
export function countCanonicalFields(
  facts: CountCommandFacts,
): Readonly<Record<string, CanonicalValue>> {
  return {
    workflow: COUNT_RECORD_OPERATION_TYPE,
    variantId: facts.variantId,
    locationId: facts.locationId,
    countedQuantity: facts.countedQuantity,
    countedAt: facts.countedAt.toISOString(),
    actorId: facts.actorId,
  };
}
