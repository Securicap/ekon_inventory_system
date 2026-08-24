import { LIFECYCLE_STATUSES, type LifecycleStatus } from '@ekon/shared';

/**
 * Merchandise lifecycle policy: what a status permits, how a product's and a
 * variant's combine, and which changes of status are allowed.
 *
 * **This is the one place any of those three questions is answered.** Receiving
 * does not decide that a discontinued item may not be replenished, removal does
 * not decide that a discontinued item may still be sold, and no query
 * re-implements "the product's status wins if it is stricter". Each of those
 * would be a copy of a rule, and copies drift — the first one to drift would be
 * a workflow quietly disagreeing with the screen about what the shop sells.
 *
 * Pure functions over the shared vocabulary. Nothing here reads the database,
 * and nothing here knows what a variant is beyond its status.
 */

/**
 * How restrictive each status is. Higher means less may be done.
 *
 * Not exported as an ordering anybody may reason with — it exists so that
 * combining a product's status with a variant's is a `max`, stated once, rather
 * than a nine-cell table somebody has to read carefully. The lifecycle really is
 * a line (`ACTIVE → DISCONTINUED → ARCHIVED`), which is why a scalar is honest
 * here and would not be for an arbitrary state machine.
 */
const RESTRICTION: Readonly<Record<LifecycleStatus, number>> = {
  ACTIVE: 0,
  DISCONTINUED: 1,
  ARCHIVED: 2,
};

/**
 * What may be done with merchandise in a given effective status.
 *
 * Four questions, because four workflows ask them and they genuinely have
 * different answers. A single `isAvailable` boolean is what this replaces, and
 * it is exactly the abstraction that broke: it could not say that a
 * discontinued item may be sold but not replenished, which is the entire point
 * of discontinuing something.
 */
export interface MerchandisePolicy {
  /** May stock be booked in against it? `RECEIPT`. */
  mayReceive: boolean;
  /** May stock be taken off the shelf? `ISSUE`. */
  mayIssue: boolean;
  /** May it be physically counted, and a variance reconciled? */
  mayCount: boolean;
  /** May its recorded history be corrected? `ADJUSTMENT_*` and `REVERSAL`. */
  mayCorrect: boolean;
}

/**
 * The policy table. Read it as the promise the lifecycle makes to the shop.
 *
 * `ACTIVE` — normal operation, everything permitted.
 *
 * `DISCONTINUED` — **no longer bought or reordered, and nothing else.** Receiving
 * is refused because replenishing something the business decided to stop
 * stocking is the one act the decision was about. Everything else stays open:
 * the units on the shelf are real, they are sold to real customers, they are
 * counted at stocktake, and they appear in current stock. A system that made
 * discontinued merchandise invisible would strand it — and stranded stock is
 * sold anyway, off the books, which is worse than not discontinuing it at all.
 *
 * `ARCHIVED` — out of day-to-day operation. Nothing may be received, issued,
 * counted, or corrected, and it leaves the current-stock view. That is only
 * safe because archiving is refused while any stock remains: an archived SKU
 * has nothing on any shelf, so there is nothing being hidden. Its history stays
 * fully readable, which is what archiving is *for*.
 *
 * Correcting archived merchandise is refused rather than allowed, and that is a
 * deliberate narrow rule rather than reuse of the issue rule. A correction is
 * about ledger truth, not about replenishment, so `DISCONTINUED` must never
 * block one — a shop that discontinues an item on Friday must still be able to
 * fix Thursday's mis-keyed receipt. But an adjustment or a reversal against
 * archived merchandise would put units back on a shelf the archive asserts is
 * empty, and would do it behind a status that has removed the item from every
 * operational screen. The remedy is explicit and cheap: restore it to
 * `DISCONTINUED`, correct the ledger, archive it again. Lifecycle is never
 * changed silently as part of a correction — that would be a workflow editing
 * merchandise policy to get its own write through.
 */
const POLICY: Readonly<Record<LifecycleStatus, MerchandisePolicy>> = {
  ACTIVE: { mayReceive: true, mayIssue: true, mayCount: true, mayCorrect: true },
  DISCONTINUED: { mayReceive: false, mayIssue: true, mayCount: true, mayCorrect: true },
  ARCHIVED: { mayReceive: false, mayIssue: false, mayCount: false, mayCorrect: false },
};

/**
 * The statuses in which merchandise is still part of day-to-day operations —
 * everything that is not archived.
 *
 * Exported as data because the catalog's operational listing has to express the
 * same rule as a SQL filter, and a hand-written `IN ('ACTIVE','DISCONTINUED')`
 * in a query would be the policy stated a second time in a language this file
 * cannot check.
 */
export const OPERATIONAL_LIFECYCLE_STATUSES: readonly LifecycleStatus[] = LIFECYCLE_STATUSES.filter(
  (status) => POLICY[status].mayIssue,
);

/**
 * The effective status of a variant: the more restrictive of its own and its
 * parent product's.
 *
 * **A variant is never more available than the product it belongs to.** An
 * `ACTIVE` variant of a `DISCONTINUED` product behaves as discontinued, and one
 * of an `ARCHIVED` product behaves as archived, whatever its own row says. The
 * reverse is the ordinary case and is left alone: a `DISCONTINUED` variant of an
 * `ACTIVE` product is one colour the shop stopped buying, and its siblings are
 * unaffected.
 *
 * Derived rather than propagated. Withdrawing a product does **not** rewrite its
 * variants' rows, because then restoring it could not know which of them the
 * shop had already discontinued on their own — the mass update would have
 * erased exactly the information needed to undo it.
 */
export function effectiveLifecycle(
  productStatus: LifecycleStatus,
  variantStatus: LifecycleStatus,
): LifecycleStatus {
  return RESTRICTION[productStatus] >= RESTRICTION[variantStatus] ? productStatus : variantStatus;
}

/** What the given effective status permits. */
export function merchandisePolicy(status: LifecycleStatus): MerchandisePolicy {
  return POLICY[status];
}

/**
 * Which lifecycle changes are permitted, and it is deliberately not "all of
 * them".
 *
 * ```text
 *            ACTIVE  ──▶  DISCONTINUED  ──▶  ARCHIVED
 *              ▲               ▲   │              │
 *              └───────────────┘   └──────────────┘
 * ```
 *
 * | from → to      | `ACTIVE`         | `DISCONTINUED`  | `ARCHIVED`               |
 * | -------------- | ---------------- | --------------- | ------------------------ |
 * | `ACTIVE`       | no-op            | yes             | yes, if stock is zero    |
 * | `DISCONTINUED` | yes, restores    | no-op           | yes, if stock is zero    |
 * | `ARCHIVED`     | **no**           | yes, restores   | no-op                    |
 *
 * The forward path is the lifecycle itself. `ACTIVE → ARCHIVED` skips a step and
 * is allowed on purpose: merchandise entered by mistake, with no stock and no
 * history worth keeping in the operational view, is archived directly, and
 * forcing it through `DISCONTINUED` would be a ritual rather than a decision.
 *
 * **Restoration exists because people click the wrong row.** A one-way tombstone
 * would mean the remedy for a mis-click is a database session, and a system
 * whose only correction path is `psql` does not have a correction path. Both
 * restoring steps go back exactly one stage:
 *
 *   `DISCONTINUED → ACTIVE` — the shop resumed buying it.
 *   `ARCHIVED → DISCONTINUED` — it is back in day-to-day operation, but nothing
 *   here claims it is being reordered again. That is a separate decision, and
 *   somebody makes it separately.
 *
 * `ARCHIVED → ACTIVE` is therefore refused: not because it is dangerous, but
 * because it answers two questions with one click, and the second answer would
 * be a guess the system made on the shop's behalf. Two deliberate steps, each
 * cheap, each recoverable.
 *
 * Nothing here consults stock. The zero-stock requirement for archiving is a
 * fact about inventory, not about the transition, and it is enforced where the
 * balance can actually be read under a lock — see `lifecycleService.ts`.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<LifecycleStatus, readonly LifecycleStatus[]>> = {
  ACTIVE: ['DISCONTINUED', 'ARCHIVED'],
  DISCONTINUED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: ['DISCONTINUED'],
};

/**
 * Whether merchandise may move from `from` to `to`.
 *
 * A transition to the status something already has is **not** a transition and
 * is not asked about here — the lifecycle service answers that as a no-op,
 * because a declarative `PATCH` restating the current state has nothing to do
 * and no reason to fail.
 */
export function isTransitionAllowed(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** The statuses reachable from `from`, for an error message that says what may be done. */
export function allowedTransitionsFrom(from: LifecycleStatus): readonly LifecycleStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

/** Archiving is the one transition that requires the merchandise to hold no stock. */
export function requiresZeroStock(to: LifecycleStatus): boolean {
  return to === 'ARCHIVED';
}
