import {
  canonicalRequestHash,
  type CanonicalValue,
} from '../../../platform/hash/canonicalRequest.js';

/**
 * The canonical form of a reversal command, and its digest.
 *
 * This is the definition of "the same correction, retried". Two requests hash
 * alike exactly when they say the same five things, and differ when any one of
 * them changes — which is what lets the posting engine tell a retry from an
 * operation id reused for something else.
 *
 * The generic canonicalization lives in `platform/hash/canonicalRequest.ts` and
 * is not reimplemented here: this file is the *field set*, which is the part a
 * reviewer has to be able to check.
 */

/**
 * Stamped on the `operations` row as its `operation_type`, and hashed as the
 * `workflow` field.
 *
 * It names the workflow, not the movement type. `REVERSAL` is how the ledger
 * records what happened; `inventory.reverse` is the command that asked for it.
 * Hashing the workflow is also what stops a reversal and, say, a removal that
 * reused one operation id from ever being mistaken for each other.
 */
export const REVERSAL_OPERATION_TYPE = 'inventory.reverse';

/**
 * Everything the digest covers, and nothing else.
 *
 * **The field set is short because the command is short.** No variant, no
 * location, no quantity, no movement type: every one of them is derived from
 * the original movement inside the transaction, so hashing them would hash
 * values the caller never sent and could not change. `movementId` already
 * identifies all of them — two reversal requests naming the same movement *are*
 * the same command, and that is exactly what this digest has to be able to say.
 *
 * No movement id of the reversal itself, no recorded time, no quantity before
 * or after: those are the ledger's answer to this command, and hashing an
 * answer would make every retry look like a different question. No operation id
 * either — the id is what the hash is stored *against*, so including it would
 * make every command hash uniquely and the comparison would never fail.
 *
 * The note is in, for the same reason it is in an adjustment's: it is the
 * caller's account of what went wrong, and two different accounts under one
 * operation id is a mistake worth refusing rather than resolving by arrival
 * order.
 */
export interface ReversalCommandFacts {
  /** The movement being reversed. The whole of what is being corrected. */
  movementId: string;
  /** Why it was wrong, or `null` when nothing was written. */
  note: string | null;
  /**
   * Business time of the correction, already normalized to an instant. Passing
   * a `Date` rather than the string off the wire is what makes
   * `10:00:00-05:00` and `15:00:00.000Z` the same command.
   */
  occurredAt: Date;
  /** The authenticated session's user. Never a value from the request body. */
  actorId: string;
}

export function reversalRequestHash(facts: ReversalCommandFacts): string {
  return canonicalRequestHash(reversalCanonicalFields(facts));
}

/** The canonical field set, exported so the hash's inputs are testable directly. */
export function reversalCanonicalFields(
  facts: ReversalCommandFacts,
): Readonly<Record<string, CanonicalValue>> {
  return {
    workflow: REVERSAL_OPERATION_TYPE,
    movementId: facts.movementId,
    note: facts.note,
    occurredAt: facts.occurredAt.toISOString(),
    actorId: facts.actorId,
  };
}
