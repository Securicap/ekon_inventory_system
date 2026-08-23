import { z } from 'zod';
import { SKU_PATTERN, variantAttributeSchema } from './catalog.js';
import { idSchema, movementTypeSchema, quantitySchema } from './movements.js';

/**
 * Stock history — the append-only ledger, read.
 *
 * `inventory_movements` has always been the evidence: what changed, by how
 * much, from what to what, why, who recorded it, when the stock moved, and when
 * Ekon recorded that it had. This contract exposes that evidence and nothing
 * else. It creates no second history table, no activity log, and no summary —
 * the ledger is the record, and this is a read of it.
 *
 * **Two timestamps, and they are not the same fact.**
 *
 *   `occurredAt` — when the stock physically moved. Business time, stated by
 *   whoever recorded the movement. A delivery counted this morning and entered
 *   this afternoon occurred this morning, so it may be earlier than
 *   `recordedAt`, and two movements may be entered out of chronological order.
 *
 *   `recordedAt` — when Ekon permanently recorded the fact. Server time, read
 *   from the ledger's own clock inside the posting transaction. This is the
 *   order the ledger was written in and it never changes.
 *
 * **Names are current labels, not historical snapshots.** The ledger stores
 * ids, quantities, the movement type, the reason, the note, both timestamps,
 * and the actor's id — permanently. It does not store the product's name, the
 * brand, the location's name, or the person's display name. Those are resolved
 * at read time from the tables that own them today, so renaming a product
 * changes what an old movement *displays* while the movement still refers to
 * the same immutable variant id and SKU. Nothing here is a snapshot of what
 * anything was called on the day it happened, and it must not be read as one.
 */

/** How many movements one page returns when the caller does not say. */
export const MOVEMENT_HISTORY_DEFAULT_PAGE_SIZE = 50;

/** The ceiling on one page. A caller asking for more is refused, not silently trimmed. */
export const MOVEMENT_HISTORY_MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * A bounded window on the ledger.
 *
 * Every filter is optional and every one of them narrows; there is no filter
 * that widens, and no way to ask for an unbounded answer. Omitting all of them
 * asks for the most recent page of everything, which is the feed somebody opens
 * when they want to know what has been happening.
 *
 * **The date filters name `recordedAt` explicitly**, and that is a decision
 * rather than a shorthand. The feed is ordered by recorded time, so a range on
 * the same column composes with the cursor and reads from the same index; a
 * range on `occurredAt` would answer a different question — "what happened on
 * the shop floor that day" — against a column that is neither the sort key nor
 * indexed. `occurredAt` is returned on every record and is not filterable here.
 * Deliberately not called `from` and `to`: with two timestamps in the ledger,
 * an unqualified name is a guess about which one somebody meant.
 *
 * `.strict()`, so a mistyped parameter is refused rather than ignored. A query
 * silently dropping `varientId` would answer with the whole ledger and look
 * like it had filtered.
 */
export const movementHistoryQuerySchema = z
  .object({
    /** One variant's history, across every location. */
    variantId: idSchema.optional(),
    /** One location's history, across every variant. */
    locationId: idSchema.optional(),
    /** One kind of change. The stable machine value, never a localized label. */
    movementType: movementTypeSchema.optional(),
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
    /**
     * Page size. Coerced because a query string carries numbers as text, and
     * bounded at both ends: zero or a negative page is not a smaller answer, it
     * is a request that means nothing.
     */
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MOVEMENT_HISTORY_MAX_PAGE_SIZE)
      .default(MOVEMENT_HISTORY_DEFAULT_PAGE_SIZE),
    /**
     * Where to resume, from a previous page's `nextCursor`. Opaque: it encodes
     * the exact position in the ledger's order, and a client that took it apart
     * would be depending on how this pagination happens to work today.
     */
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

export type MovementHistoryQuery = z.infer<typeof movementHistoryQuerySchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Who recorded the movement.
 *
 * `id` is permanent ledger evidence and is always present — `user_id` is
 * `NOT NULL` on every movement. `displayName` is a **current label** and is
 * `null` when the id does not resolve to a user today.
 *
 * That is a real state rather than a defensive one. `inventory_movements.user_id`
 * deliberately carries no foreign key onto `users` (INV-11): movements existed
 * before the identity module did, and some carry actor uuids that were never
 * accounts. The id is never discarded because a name cannot be found, and no
 * name is ever invented to fill the gap.
 */
export const movementActorSchema = z
  .object({
    id: idSchema,
    displayName: z.string().nullable(),
  })
  .strict();

export type MovementActor = z.infer<typeof movementActorSchema>;

/**
 * The merchandise a movement was about, labelled well enough to read the record
 * without a second request.
 *
 * `id` and `sku` are the permanent identity; the names are current labels.
 * Resolved regardless of whether the variant may be stocked today — history is
 * evidence, not the current-stock list, and a movement against merchandise the
 * shop has since retired is exactly the one somebody goes looking for.
 *
 * Deliberately narrow: no price, no reference cost, no classification, no
 * barcode, no lifecycle. None of them is evidence about a stock movement, and
 * each would couple this read to more of the merchandise model than it needs.
 */
export const movementVariantSchema = z
  .object({
    id: idSchema,
    productId: idSchema,
    productName: z.string(),
    /** `null` for merchandise nobody has given a brand. Never guessed from a name. */
    brandName: z.string().nullable(),
    sku: z.string().regex(SKU_PATTERN),
    /** In the catalog's deterministic order, by normalized attribute name. */
    attributes: z.array(variantAttributeSchema),
  })
  .strict();

export type MovementVariant = z.infer<typeof movementVariantSchema>;

/**
 * Where the stock moved. Resolved whether or not the location is still active:
 * a shelf that has been closed still has a history, and hiding it would make
 * the movements that happened there unreadable.
 */
export const movementLocationSchema = z
  .object({
    id: idSchema,
    name: z.string(),
  })
  .strict();

export type MovementLocation = z.infer<typeof movementLocationSchema>;

/**
 * One movement, as evidence.
 *
 * `.strict()` on purpose, and the omissions are decisions.
 *
 * **`previousMovementId` is not here.** It is the chain pointer that makes two
 * concurrent writers unable to claim the same starting quantity (INV-4) — an
 * integrity mechanism, not a business fact. It answers nothing
 * `quantityBefore` and `quantityAfter` do not already answer, and exposing it
 * would invite a client to reconstruct the ledger's internal structure and then
 * depend on it.
 *
 * **`reversesMovementId` is here**, and so is `reversedByMovementId`. The
 * correction relationship is evidence, and it is evidence in both directions:
 * a reversal has to say what it undid, and — more importantly — a movement that
 * was undone has to say so, or somebody scrolling past a receipt of 10 would
 * read it as stock the shop received and keep looking for where it went. The
 * ledger stores the pointer on the reversal row only; the second field is
 * derived from that same row by the read, never stored twice.
 *
 * The request hash, the operation's stored result pointer, and the balance
 * projection are all absent: they are how the server keeps its own promises.
 * `operationId` **is** here, because it is what ties a movement back to the
 * command that produced it, and it is what somebody investigating a suspected
 * duplicate asks about.
 */
export const inventoryMovementRecordSchema = z
  .object({
    id: idSchema,
    /** The stable machine value. Localization is the interface's problem, not the ledger's. */
    movementType: movementTypeSchema,
    /** Signed, and never zero: positive brought stock in, negative took it out. */
    quantityDelta: z.number().int(),
    /** What the shelf held before this movement, as the ledger recorded it. */
    quantityBefore: quantitySchema,
    /** And after. `quantityBefore + quantityDelta`, guaranteed by a CHECK (INV-3). */
    quantityAfter: quantitySchema,
    /**
     * Why, for the types that require one — every `ISSUE` and every adjustment
     * (INV-11). The stored code, never a translation: `SOLD` means the same
     * thing whatever language the person choosing it was reading.
     *
     * `ISSUE` + `SOLD` is returned as exactly that, and is deliberately not
     * collapsed into a `SALE`. The ledger records that stock left and why; there
     * is no sale entity in this system, and `Remove → SOLD` is transitional
     * rather than the permanent sales architecture (ADR 11).
     */
    reasonCode: z.string().nullable(),
    /** Free text somebody typed at the counter. Bounded, never policed. */
    note: z.string().nullable(),
    /** Business time: when the stock physically moved. May precede `recordedAt`. */
    occurredAt: z.string().datetime(),
    /** Server time: when Ekon recorded the fact. This is the ledger's own order. */
    recordedAt: z.string().datetime(),
    /** The command this movement came from, and what a retry named. */
    operationId: idSchema,
    /**
     * The movement this one reverses. Set on `REVERSAL` rows and `null` on
     * every other type — a CHECK enforces both directions (0005).
     */
    reversesMovementId: idSchema.nullable(),
    /**
     * The `REVERSAL` that undid this movement, when one exists.
     *
     * **Derived, not stored.** The ledger keeps one pointer, on the reversal,
     * and `UNIQUE (reverses_movement_id)` guarantees at most one reversal per
     * movement — so this is that same unique relationship read the other way
     * round, resolved in the history query's own join rather than by a lookup
     * per row. There is no second column and no denormalized flag to fall out
     * of step with the ledger.
     *
     * A movement carrying one is corrected, not deleted: both rows remain, both
     * are shown, and the arithmetic of each is still exactly what the ledger
     * recorded at the time (INV-1, INV-2).
     */
    reversedByMovementId: idSchema.nullable(),
    variant: movementVariantSchema,
    location: movementLocationSchema,
    actor: movementActorSchema,
  })
  .strict();

export type InventoryMovementRecord = z.infer<typeof inventoryMovementRecordSchema>;

/**
 * One page of history, newest recorded first.
 *
 * `nextCursor` is `null` on the last page, and only then — a page that comes
 * back full but with a null cursor is the end, not an invitation to ask again.
 */
export const movementHistoryPageSchema = z
  .object({
    items: z.array(inventoryMovementRecordSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type MovementHistoryPage = z.infer<typeof movementHistoryPageSchema>;
