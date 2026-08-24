import { z } from 'zod';
import {
  movementActorSchema,
  movementLocationSchema,
  movementVariantSchema,
  MOVEMENT_HISTORY_DEFAULT_PAGE_SIZE,
  MOVEMENT_HISTORY_MAX_PAGE_SIZE,
} from './movementHistory.js';
import {
  MAX_MOVEMENT_QUANTITY,
  idSchema,
  noteSchema,
  occurredAtSchema,
  operationIdSchema,
  quantitySchema,
} from './movements.js';

/**
 * Physical counts — what somebody saw on the shelf, and what the shop decided
 * to do about the difference.
 *
 * ```text
 * SYSTEM EXPECTED
 *        +
 * PHYSICAL OBSERVATION
 *        ↓
 *    DISCREPANCY
 *        ↓
 *  INVESTIGATION
 *        ↓
 * RECONCILIATION DECISION
 *        ↓
 * COUNT_RECONCILIATION movement, if the variance is not zero
 * ```
 *
 * **A count observes. Investigation explains. Reconciliation changes stock.**
 * Those are three acts, and this contract keeps them three. Recording that six
 * were seen where Ekon expected seven does **not** make the balance six: that
 * would destroy the only signal the shop had, which is that one unit is
 * unaccounted for. The variance stays visible until somebody with authority
 * accepts it and says why.
 *
 * The causes of a −1 are not interchangeable — a sale nobody entered, damage, a
 * missed receipt, a mis-key, stock on another shelf, a counting mistake, theft
 * — and a system that flattens all of them into "set it to six" cannot tell a
 * shop it is being stolen from.
 *
 * **This is not a stocktake platform.** One observation covers one variant at
 * one location. There are no count sessions, no campaigns, no blind counts, no
 * second counts, no approval thresholds, and no review queues.
 */

/**
 * What a count observation *is*, once it exists.
 *
 * Three values, because there are genuinely three states and no useful fourth:
 *
 * - `MATCHED` — the shelf agreed with the record. Settled the moment it was
 *   recorded: there is nothing to investigate, nothing to accept, and nothing
 *   to post. Somebody checked, and it was right, which is itself worth keeping.
 * - `OPEN` — a variance nobody has resolved yet. This is the state the whole
 *   workflow exists to make visible.
 * - `RECONCILED` — a variance somebody explicitly accepted, with a reason and a
 *   `COUNT_RECONCILIATION` movement behind it.
 *
 * `MATCHED` and `RECONCILED` are deliberately not one "settled" value. Nothing
 * was decided about a match and nobody accepted anything, so calling it
 * reconciled would attribute a judgement to a person who never made one.
 *
 * Deliberately absent: `DRAFT`, `SUBMITTED`, `MANAGER_REVIEW`, `APPROVED`,
 * `REJECTED`, `SECOND_COUNT_REQUIRED`, `CLOSED`, `CANCELLED`. Every one of them
 * belongs to an approval workflow this shop does not have, and a status nobody
 * sets is a status somebody eventually sets wrongly.
 *
 * **The status is derived, not chosen.** The database computes it from the
 * variance and whether a reconciliation exists, so it cannot disagree with the
 * numbers beside it and no client may ever state one.
 */
export const COUNT_STATUSES = ['MATCHED', 'OPEN', 'RECONCILED'] as const;

export const countStatusSchema = z.enum(COUNT_STATUSES);
export type CountStatus = z.infer<typeof countStatusSchema>;

/**
 * Why a discrepancy was **accepted**. A closed set, and every entry names a
 * conclusion an investigation can actually reach.
 *
 * These are not the adjustment reasons. An adjustment says the recorded number
 * was wrong with no physical observation necessarily behind it; a
 * reconciliation says *somebody counted the shelf, it differed, we looked into
 * it, and this is what we concluded*. Reusing one vocabulary for both would
 * make the ledger unable to tell a correction from an investigated variance.
 *
 * - `UNRECORDED_SALE` — stock left as a sale nobody entered. The shop is
 *   accepting the loss of the unit rather than reconstructing the sale. If the
 *   sale's details are known, recording the missing `ISSUE` is the better
 *   answer, and nothing here does that automatically.
 * - `MISSED_RECEIPT` — stock arrived and was never booked in. The ordinary
 *   cause of a positive variance.
 * - `DAMAGED` — units were broken or spoiled and discarded without being
 *   recorded.
 * - `MISPLACED_STOCK` — the units are real and are somewhere else. This
 *   location's record was wrong about where they sit.
 * - `SHRINKAGE` — unaccounted loss. Deliberately not `THEFT`: a count can
 *   establish that stock is gone and cannot establish who took it, and a
 *   machine-readable accusation is not something this system should be able to
 *   record. The note is where somebody writes what was actually found.
 * - `DATA_ENTRY_ERROR` — an earlier movement was entered wrongly and the shelf
 *   is right. When the specific wrong movement is known, reversing it (PR 5)
 *   keeps the mistake and its remedy linked; this is for when it is not.
 * - `OTHER` — anything else, and it **requires a note**.
 *
 * **`COUNTING_ERROR` is deliberately not here**, and that omission is the most
 * important thing in this list. If the count itself was wrong, the shelf never
 * differed and there is nothing to accept — the answer is to count again and
 * record a *new* observation, which leaves both the mistaken count and the
 * corrected one as evidence. A reason code that let somebody post a stock
 * movement derived from a quantity they believe is false would turn this
 * workflow into a way of laundering bad data through the ledger.
 */
export const COUNT_RECONCILIATION_REASONS = [
  'UNRECORDED_SALE',
  'MISSED_RECEIPT',
  'DAMAGED',
  'MISPLACED_STOCK',
  'SHRINKAGE',
  'DATA_ENTRY_ERROR',
  'OTHER',
] as const;

export const countReconciliationReasonSchema = z.enum(COUNT_RECONCILIATION_REASONS);
export type CountReconciliationReason = z.infer<typeof countReconciliationReasonSchema>;

// ---------------------------------------------------------------------------
// Recording an observation
// ---------------------------------------------------------------------------

/**
 * `POST /api/inventory/counts`.
 *
 * The caller states **only what a person saw**, and the server states what Ekon
 * expected. That split is the whole of INV-9 in one schema.
 *
 * `.strict()`, and the refusals matter more here than anywhere:
 *
 * - `expectedQuantity` — the server reads it from the balance projection inside
 *   the recording transaction. A client that could supply it could make any
 *   variance it liked, and the variance is the evidence.
 * - `variance` — derived from the two quantities by the database itself.
 * - `status` — derived from the variance and the reconciliation.
 * - `movementId`, `reconciledBy`, `reconciledAt`, `reason` — a fresh
 *   observation has decided nothing, and a body that could carry them would be
 *   recording an investigation nobody performed.
 * - `recordedAt`, `countedByUserId`, `id` — server-owned, as everywhere.
 *
 * What the caller does own:
 *
 * - `operationId` — generated when the form opens and reused on every retry.
 *   A count observation moves no stock, but it is durable business evidence,
 *   and a dropped connection must not leave two records of one shelf-check.
 * - `variantId`, `locationId` — what was counted, and where.
 * - `countedQuantity` — how many were physically there. Zero is a real answer.
 * - `countedAt` — when the shelf was actually counted, which is routinely
 *   earlier than when somebody got to a computer.
 */
export const recordCountRequestSchema = z
  .object({
    operationId: operationIdSchema,
    variantId: idSchema,
    locationId: idSchema,
    /**
     * What was physically on the shelf. Whole units, and **zero is valid** —
     * an empty shelf is an observation, and refusing it would make the one
     * count somebody most needs to record impossible.
     *
     * Bounded by the ledger's own integer ceiling so a quantity that could
     * never be stored is a `400` rather than a failure inside a transaction.
     */
    countedQuantity: z
      .number()
      .int('countedQuantity must be a whole number of units')
      .nonnegative('countedQuantity must not be negative')
      .max(MAX_MOVEMENT_QUANTITY),
    /** Business time: when the shelf was counted. May precede `recordedAt`. */
    countedAt: occurredAtSchema,
  })
  .strict();

export type RecordCountRequest = z.infer<typeof recordCountRequestSchema>;

// ---------------------------------------------------------------------------
// The evidence
// ---------------------------------------------------------------------------

/**
 * What was decided about a discrepancy, once somebody decided it.
 *
 * `null` on an `OPEN` count, because nothing has been decided, and `null` on a
 * `MATCHED` one, because there was nothing to decide. Present only on
 * `RECONCILED`, and then always complete: a reason, when, who, and the movement
 * that changed the stock.
 *
 * `movementId` is never null here. A reconciliation that changed no stock is
 * not a reconciliation — a zero variance settles as `MATCHED` without one.
 */
export const countReconciliationSchema = z
  .object({
    reason: countReconciliationReasonSchema,
    /** What was found, in the reconciler's words. `null` when none was written. */
    note: z.string().nullable(),
    reconciledAt: z.string().datetime(),
    actor: movementActorSchema,
    /** The `COUNT_RECONCILIATION` this decision posted. */
    movementId: idSchema,
  })
  .strict();

export type CountReconciliation = z.infer<typeof countReconciliationSchema>;

/**
 * One count observation, as evidence.
 *
 * **The three numbers are a permanent snapshot and are never recomputed.**
 * `expectedQuantity` is what Ekon held for that shelf at the moment the
 * observation was recorded; a receipt, a sale, an adjustment, or a reversal
 * posted afterwards changes today's balance and changes nothing here. A read
 * that recalculated the variance against the current balance would rewrite
 * history every time the shop traded, and the record of what the counter
 * actually saw would be gone.
 *
 * **The labels are current, not historical** — the same rule PR 4 states for
 * movement history. The count stores ids, quantities, timestamps and decisions;
 * the product name, the brand, the location name, and the people's display
 * names are resolved at read time from the tables that own them today. Renaming
 * a product changes what an old count *displays* while the count still refers
 * to the same immutable variant id and SKU. Nothing here is a snapshot of what
 * anything was called on the day it was counted.
 *
 * The label shapes are PR 4's, reused rather than copied: a count and a
 * movement label the same merchandise, the same shelf, and the same people, and
 * two definitions of one shape are two things to keep in step.
 */
export const countRecordSchema = z
  .object({
    id: idSchema,
    variant: movementVariantSchema,
    location: movementLocationSchema,
    /** What Ekon held for that shelf when the observation was recorded. */
    expectedQuantity: quantitySchema,
    /** What was physically there. */
    countedQuantity: quantitySchema,
    /** `countedQuantity - expectedQuantity`. Negative, zero, or positive. */
    variance: z.number().int(),
    /** Business time: when the shelf was counted. */
    countedAt: z.string().datetime(),
    /** Server time: when Ekon recorded the observation. */
    recordedAt: z.string().datetime(),
    /** Who counted. Permanent id; the display name is a current label. */
    counter: movementActorSchema,
    status: countStatusSchema,
    /** `null` until a discrepancy is accepted, and always `null` for a match. */
    reconciliation: countReconciliationSchema.nullable(),
  })
  .strict();

export type CountRecord = z.infer<typeof countRecordSchema>;

/**
 * The result of recording an observation: the observation, as persisted.
 *
 * Not a movement result, and deliberately not shaped like one. Recording a
 * count posts nothing to the ledger — a discrepancy has no movement yet and a
 * match will never have one — so there is no `movementId` and no
 * `quantityAfter` to report. What the caller could not know, and is told, is
 * `expectedQuantity`, and therefore the variance.
 */
export const recordCountResponseSchema = countRecordSchema;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A bounded window on the count evidence.
 *
 * Every filter is optional and every one narrows; there is no way to ask for an
 * unbounded answer. Omitting all of them asks for the most recent page of
 * everything, and `status=OPEN` asks the question the workflow exists for:
 * *what is still unexplained?*
 *
 * The date filters name `recordedAt` explicitly, for the reason PR 4 gives: the
 * feed is ordered by recorded time, so a range on the same column composes with
 * the cursor and reads from the same index. `countedAt` is returned on every
 * record and is not filterable.
 *
 * `.strict()`, so a mistyped parameter is refused rather than ignored — a query
 * filtered by `varientId` would otherwise be answered with every count and look
 * like it had worked.
 */
export const countQuerySchema = z
  .object({
    /** `OPEN` is the discrepancy list. `MATCHED` and `RECONCILED` are settled. */
    status: countStatusSchema.optional(),
    variantId: idSchema.optional(),
    locationId: idSchema.optional(),
    /** Inclusive lower bound on `recordedAt`. */
    recordedFrom: z
      .string()
      .datetime({ offset: true, message: 'recordedFrom must be an ISO 8601 timestamp' })
      .optional(),
    /** Inclusive upper bound on `recordedAt`. */
    recordedTo: z
      .string()
      .datetime({ offset: true, message: 'recordedTo must be an ISO 8601 timestamp' })
      .optional(),
    /** Page size, coerced because a query string carries numbers as text. */
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MOVEMENT_HISTORY_MAX_PAGE_SIZE)
      .default(MOVEMENT_HISTORY_DEFAULT_PAGE_SIZE),
    /** Where to resume, from a previous page's `nextCursor`. Opaque. */
    cursor: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.recordedFrom === undefined ||
      query.recordedTo === undefined ||
      Date.parse(query.recordedFrom) <= Date.parse(query.recordedTo),
    { message: 'recordedFrom must not be after recordedTo', path: ['recordedFrom'] },
  );

export type CountQuery = z.infer<typeof countQuerySchema>;

/**
 * One page of count evidence, newest recorded first.
 *
 * The same keyset pagination the movement feed uses, and for the same reason: a
 * count recorded while somebody is reading page four cannot shift a row across
 * a page boundary. `nextCursor` is `null` on the last page and only then.
 */
export const countPageSchema = z
  .object({
    items: z.array(countRecordSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type CountPage = z.infer<typeof countPageSchema>;

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * `POST /api/inventory/counts/:countId/reconcile`.
 *
 * Accepting a discrepancy: *this observation is the correct shelf quantity, and
 * here is why the difference is real*.
 *
 * The body carries a decision and nothing else. Everything about **what moves**
 * comes from the persisted count — the variant, the location, and a delta of
 * `countedQuantity - expectedQuantity` — so none of it is a request field. A
 * caller that could state the delta could accept a discrepancy other than the
 * one that was observed, and the count would no longer be evidence of anything.
 *
 * Refused: `variantId`, `locationId`, `expectedQuantity`, `countedQuantity`,
 * `variance`, `quantityDelta`, `movementType`, `movementId`, `reconciledBy`,
 * `status`, `occurredAt`.
 *
 * `occurredAt` in particular: the reconciliation movement's business time is
 * the count's own `countedAt`, because that is when the discrepancy physically
 * existed. Accepting it later is a decision about a past observation, not a new
 * event on the shelf.
 */
export const reconcileCountRequestSchema = z
  .object({
    operationId: operationIdSchema,
    reason: countReconciliationReasonSchema,
    /**
     * What the investigation found, in the reconciler's words. Optional in
     * general and **required for `OTHER`**, which is the only reason that says
     * nothing on its own.
     *
     * A note is not a reason: the reason is a code a report can count, and the
     * note is the sentence beside it. Investigative prose does not belong in
     * `reason_code`, and a reason nobody can count does not belong anywhere.
     */
    note: noteSchema.optional(),
  })
  .strict()
  .refine((request) => request.reason !== 'OTHER' || request.note !== undefined, {
    message: 'A note is required when the reason is OTHER',
    path: ['note'],
  });

export type ReconcileCountRequest = z.infer<typeof reconcileCountRequestSchema>;

/**
 * The result of reconciling: the count, settled.
 *
 * The whole record rather than a movement result, because the caller's question
 * was about the discrepancy and the answer is what became of it — including the
 * `movementId` inside `reconciliation`, which is how somebody gets from the
 * decision to its effect on stock.
 */
export const reconcileCountResponseSchema = countRecordSchema;

/**
 * The path parameter of the reconcile route.
 *
 * A path parameter is request input like any other, and an unparsed one is an
 * unvalidated one: `/api/inventory/counts/not-a-uuid/reconcile` would otherwise
 * reach the database and come back as an internal error about uuid syntax
 * rather than as the `400` it is.
 */
export const countPathParamsSchema = z.object({ countId: idSchema }).strict();
