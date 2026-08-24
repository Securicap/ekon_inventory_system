import type { MovementType } from '@ekon/shared';
import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';

/**
 * Reading the ledger.
 *
 * A separate file from `ledgerRepository.ts`, and deliberately: that one is the
 * posting engine's persistence — every write in it takes a transaction client,
 * and its two reads exist only to answer a replayed operation. This one holds a
 * single bounded query that runs on the pool, takes no lock, opens no
 * transaction, and writes nothing. Putting a paginated history query beside the
 * insert that appends to the same table would make one file the place where
 * both "how a movement is made" and "how the ledger is browsed" get decided.
 *
 * **Nothing here can write.** There is no INSERT, UPDATE, or DELETE in this
 * file, the database refuses the last two on this table anyway (INV-1), and the
 * convention checker fails the build on either appearing in source.
 */

/** Read-only access: the pool, or a transaction already in progress. */
type Queryable = DatabasePool | DatabaseClient;

/**
 * One movement, straight out of the ledger. The permanent facts and nothing
 * resolved: labelling is the service's job, and it does it in bulk.
 *
 * `previousMovementId` is not selected. It is the chain pointer that makes the
 * history of a shelf unforkable (INV-4) — an integrity mechanism rather than
 * evidence — and nothing above this layer has a use for it.
 */
export interface LedgerEntry {
  id: string;
  variantId: string;
  locationId: string;
  movementType: MovementType;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  reasonCode: string | null;
  note: string | null;
  operationId: string;
  reversesMovementId: string | null;
  /**
   * The `REVERSAL` that undid this movement, if one exists.
   *
   * Read back through the unique index on `reverses_movement_id` rather than
   * stored: the ledger keeps one pointer, on the reversal, and this is that
   * same relationship followed the other way. A movement can have at most one,
   * which is what makes a single left join the whole answer (INV-2).
   */
  reversedByMovementId: string | null;
  /**
   * The physical count this movement reconciled, if it is one.
   *
   * Read back through `inventory_count_lines.reconciliation_movement_id`, which
   * is unique — so, like the field above, this is one stored relationship
   * followed the other way rather than a second column on the ledger. The
   * ledger carries nothing about counts at all.
   */
  countId: string | null;
  userId: string;
  occurredAt: Date;
  recordedAt: Date;
  /**
   * `recorded_at` in PostgreSQL's own text form, carried alongside the `Date`.
   *
   * The column is `timestamptz` and holds microseconds; a JavaScript `Date`
   * holds milliseconds. Everything this application writes goes through the
   * injected clock and is therefore millisecond-precision already, so the two
   * agree today — but a cursor built from the rounded value would, the first
   * time they did not, either skip a movement or return one twice. The cursor
   * is built from this instead, and compared as a `timestamptz` again on the
   * way back in, so the position is exact whatever wrote the row.
   */
  recordedAtExact: string;
}

export interface MovementHistoryFilter {
  variantId?: string | undefined;
  locationId?: string | undefined;
  movementType?: MovementType | undefined;
  /** Inclusive bounds on `recorded_at`, the column the feed is ordered by. */
  recordedFrom?: Date | undefined;
  recordedTo?: Date | undefined;
  /** Resume strictly after this position in the ledger's order. */
  after?: { recordedAt: string; id: string } | undefined;
  /** How many rows to return. The caller asks for one more than a page. */
  limit: number;
}

interface MovementHistoryRow {
  id: string;
  variant_id: string;
  location_id: string;
  movement_type: MovementType;
  quantity_delta: number;
  quantity_before: number;
  quantity_after: number;
  reason_code: string | null;
  note: string | null;
  operation_id: string;
  reverses_movement_id: string | null;
  reversed_by_movement_id: string | null;
  count_id: string | null;
  user_id: string;
  occurred_at: Date;
  recorded_at: Date;
  recorded_at_exact: string;
}

/**
 * One page of the ledger, newest recorded first.
 *
 * **Ordered by `recorded_at DESC, id DESC`** — the order Ekon wrote the ledger
 * in, which is append-only and therefore never changes. Not by `occurred_at`:
 * that is business time, it may be stated as earlier than the movement before
 * it, and sorting by it would make the ledger's insertion order appear to
 * rearrange itself as late entries arrived. Both timestamps are returned; only
 * one of them is an order.
 *
 * `id` breaks the tie. Ids are UUIDv7 and time-ordered, so within one
 * millisecond `id DESC` still reads newest-first, and the pair is unique
 * because `id` is the primary key — which is what makes the keyset comparison
 * below total rather than merely mostly-total.
 *
 * **Keyset pagination, not OFFSET.** `(recorded_at, id) < (…)` resumes at an
 * exact position, so a movement posted while somebody is reading page four
 * cannot shift a row across a page boundary and make it appear twice or not at
 * all. An OFFSET into an append-only table that grows at the front does exactly
 * that. It also reads one index range instead of counting past every earlier
 * row, which is what keeps a deep page as cheap as a shallow one
 * (`inventory_movements_recorded_at_idx`, 0011).
 *
 * Every filter is optional and every one narrows. There is no code path here
 * that returns an unbounded result: `limit` is required, and the service caps
 * it before this is called.
 */
export async function listMovementHistory(
  db: Queryable,
  filter: MovementHistoryFilter,
): Promise<LedgerEntry[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // Every condition names the `m` alias. The query left-joins the reversal of
  // each movement, so an unqualified `id` or `recorded_at` would be ambiguous —
  // and, worse, could silently bind to the joined reversal instead of the row
  // being filtered.
  if (filter.variantId !== undefined) conditions.push(`m.variant_id = ${bind(filter.variantId)}`);
  if (filter.locationId !== undefined) {
    conditions.push(`m.location_id = ${bind(filter.locationId)}`);
  }
  if (filter.movementType !== undefined) {
    conditions.push(`m.movement_type = ${bind(filter.movementType)}`);
  }
  if (filter.recordedFrom !== undefined) {
    conditions.push(`m.recorded_at >= ${bind(filter.recordedFrom)}`);
  }
  if (filter.recordedTo !== undefined) {
    conditions.push(`m.recorded_at <= ${bind(filter.recordedTo)}`);
  }
  if (filter.after !== undefined) {
    // Row-value comparison, so the pair is compared as one position rather than
    // as two conditions that would need an OR to be correct.
    conditions.push(
      `(m.recorded_at, m.id) < (${bind(filter.after.recordedAt)}::timestamptz, ${bind(filter.after.id)}::uuid)`,
    );
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  // Two left joins, answering "was this movement reversed?" and "which count
  // did it reconcile?" for the whole page in the page's own query. Neither is
  // an N+1 and neither can become one: there is no per-row lookup, and both
  // `UNIQUE (reverses_movement_id)` (0005) and
  // `UNIQUE (reconciliation_movement_id)` (0013) mean each join matches at most
  // one row per movement — so they can neither multiply the page nor need a
  // DISTINCT. Those unique constraints are also the indexes the joins probe,
  // which is why a page costs what it did before either column existed.
  const { rows } = await db.query<MovementHistoryRow>(
    `SELECT m.id, m.variant_id, m.location_id, m.movement_type,
            m.quantity_delta, m.quantity_before, m.quantity_after,
            m.reason_code, m.note, m.operation_id, m.reverses_movement_id,
            r.id AS reversed_by_movement_id,
            c.id AS count_id,
            m.user_id, m.occurred_at, m.recorded_at,
            m.recorded_at::text AS recorded_at_exact
       FROM inventory_movements m
       LEFT JOIN inventory_movements r ON r.reverses_movement_id = m.id
       LEFT JOIN inventory_count_lines c ON c.reconciliation_movement_id = m.id
      ${where}
      ORDER BY m.recorded_at DESC, m.id DESC
      LIMIT ${bind(filter.limit)}`,
    params,
  );

  return rows.map(toEntry);
}

function toEntry(row: MovementHistoryRow): LedgerEntry {
  return {
    id: row.id,
    variantId: row.variant_id,
    locationId: row.location_id,
    movementType: row.movement_type,
    quantityDelta: row.quantity_delta,
    quantityBefore: row.quantity_before,
    quantityAfter: row.quantity_after,
    reasonCode: row.reason_code,
    note: row.note,
    operationId: row.operation_id,
    reversesMovementId: row.reverses_movement_id,
    reversedByMovementId: row.reversed_by_movement_id,
    countId: row.count_id,
    userId: row.user_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    recordedAtExact: row.recorded_at_exact,
  };
}
