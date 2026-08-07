import type { RemovalReason } from '@ekon/shared';
import {
  canonicalRequestHash,
  type CanonicalValue,
} from '../../../platform/hash/canonicalRequest.js';

/**
 * The canonical form of a removal command, and its digest.
 *
 * This is the definition of "the same stock-out, retried". Two requests hash
 * alike exactly when they say the same seven things, and differ when any one of
 * them changes — which is what lets the posting engine tell a retry from an
 * operation id reused for something else.
 *
 * The generic canonicalization lives in `platform/hash/canonicalRequest.ts` and
 * is not reimplemented here: this file is the *field set*, which is the part a
 * reviewer has to be able to check. Receiving's equivalent is beside it, and
 * the two are deliberately separate rather than parameterized — which fields
 * make up a command is each workflow's own statement, and a shared "hash any
 * movement command" helper would be a place for one workflow's fields to
 * quietly become another's.
 */

/**
 * Stamped on the `operations` row as its `operation_type`, and hashed as the
 * `workflow` field.
 *
 * It names the workflow, not the movement type. `ISSUE` is how the ledger
 * records what happened; `inventory.remove` is the command that asked for it,
 * and a later workflow that also posts issues — a point of sale, say — would be
 * a different command with the same movement type. Hashing the workflow keeps
 * those apart under one operation id, and keeps a removal from ever being
 * mistaken for a receipt that happened to reuse an id.
 */
export const REMOVAL_OPERATION_TYPE = 'inventory.remove';

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
 * No movement type and no quantity delta either, and that is deliberate rather
 * than an oversight. Both are derived: `inventory.remove` always posts an
 * `ISSUE`, and the delta is always the negation of `quantity`. Hashing a value
 * the workflow computed from another value in the same hash would add a field
 * that cannot vary independently — it would look like protection and provide
 * none. The `workflow` field already separates this command from every other
 * shape of command.
 *
 * `actorId` is in, because who took the stock off the shelf is part of what
 * happened. The same removal recorded by a different person is a different
 * business fact, and reusing an operation id across two people is a mistake
 * worth refusing rather than silently attributing to whoever got there first.
 */
export interface RemovalCommandFacts {
  variantId: string;
  locationId: string;
  /**
   * The **public, positive** quantity — the number the caller stated, not the
   * negative delta the engine is handed.
   *
   * Hashing what was asked rather than how it is stored is what makes the
   * digest a digest of the request. It also means there is exactly one
   * representation of a removal of five units, which matters because a hash
   * with two spellings of one command cannot recognize a retry.
   */
  quantity: number;
  /** Why the stock left. The closed business vocabulary, never free text. */
  reason: RemovalReason;
  /**
   * Already normalized to an instant. Passing a `Date` rather than the string
   * off the wire is what makes `10:00:00-05:00` and `15:00:00.000Z` the same
   * command: both arrive here as one instant and are serialized one way.
   */
  occurredAt: Date;
  /** The authenticated session's user. Never a value from the request body. */
  actorId: string;
}

export function removalRequestHash(facts: RemovalCommandFacts): string {
  return canonicalRequestHash(removalCanonicalFields(facts));
}

/** The canonical field set, exported so the hash's inputs are testable directly. */
export function removalCanonicalFields(
  facts: RemovalCommandFacts,
): Readonly<Record<string, CanonicalValue>> {
  return {
    workflow: REMOVAL_OPERATION_TYPE,
    variantId: facts.variantId,
    locationId: facts.locationId,
    quantity: facts.quantity,
    reason: facts.reason,
    occurredAt: facts.occurredAt.toISOString(),
    actorId: facts.actorId,
  };
}
