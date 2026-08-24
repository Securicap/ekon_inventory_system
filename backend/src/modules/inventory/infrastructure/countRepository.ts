import type { CountReconciliationReason, CountStatus } from '@ekon/shared';
import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';
import { AppError } from '../../../platform/http/errors.js';

/**
 * Count persistence: `inventory_count_lines`, and nothing else.
 *
 * Two kinds of statement live here, and the difference matters more than usual.
 *
 * **The observation is written once.** There is no update of what was counted,
 * where, by whom, when, or what Ekon expected — a database trigger refuses one
 * (0013), and the only honest way to fix a wrong count is to record another.
 * The single UPDATE below writes the reconciliation columns of a row that has
 * none, and the same trigger refuses even that a second time.
 *
 * **The reads never recompute.** `expected_quantity`, `counted_quantity` and
 * `variance` come back exactly as they were stored. Nothing here compares a
 * count against today's balance, because a count is evidence about the moment
 * it was taken and a read that recalculated it would rewrite that evidence
 * every time the shop traded.
 */

/** Read-only access: the pool, or a transaction already in progress. */
type Queryable = DatabasePool | DatabaseClient;

/** Marks an `operations` row whose result is a physical count observation. */
export const COUNT_RESULT_RESOURCE_TYPE = 'inventory_count_line';

/**
 * A count line as the rest of the backend sees it.
 *
 * Timestamps stay as `Date`; the service maps them to the wire. `variance` and
 * `status` are read rather than derived here — the database generates both, so
 * reading them is reading the same answer every other reader gets.
 */
export interface CountLine {
  id: string;
  variantId: string;
  locationId: string;
  expectedQuantity: number;
  countedQuantity: number;
  variance: number;
  countedByUserId: string;
  countedAt: Date;
  recordedAt: Date;
  /** PostgreSQL's own text rendering of `recorded_at`, for the page cursor. */
  recordedAtExact: string;
  operationId: string;
  status: CountStatus;
  reconciliationReason: CountReconciliationReason | null;
  reconciliationNote: string | null;
  reconciledByUserId: string | null;
  reconciledAt: Date | null;
  reconciliationOperationId: string | null;
  reconciliationMovementId: string | null;
}

interface CountLineRow {
  id: string;
  variant_id: string;
  location_id: string;
  expected_quantity: number;
  counted_quantity: number;
  variance: number;
  counted_by_user_id: string;
  counted_at: Date;
  recorded_at: Date;
  recorded_at_exact: string;
  operation_id: string;
  status: CountStatus;
  reconciliation_reason: CountReconciliationReason | null;
  reconciliation_note: string | null;
  reconciled_by_user_id: string | null;
  reconciled_at: Date | null;
  reconciliation_operation_id: string | null;
  reconciliation_movement_id: string | null;
}

const COLUMNS = `id, variant_id, location_id,
                 expected_quantity, counted_quantity, variance,
                 counted_by_user_id, counted_at, recorded_at,
                 recorded_at::text AS recorded_at_exact,
                 operation_id, status,
                 reconciliation_reason, reconciliation_note,
                 reconciled_by_user_id, reconciled_at,
                 reconciliation_operation_id, reconciliation_movement_id`;

export interface InsertCountLineParams {
  id: string;
  variantId: string;
  locationId: string;
  /** Read from the balance projection inside this transaction. Never from a request. */
  expectedQuantity: number;
  countedQuantity: number;
  countedByUserId: string;
  countedAt: Date;
  recordedAt: Date;
  operationId: string;
}

/**
 * Records one observation.
 *
 * `variance` and `status` are absent from the insert and cannot be added to it:
 * PostgreSQL refuses a value for a generated column, so the arithmetic and the
 * state are the database's answer rather than this application's claim about
 * it. Read back with RETURNING for the same reason every other insert here is —
 * the caller sees what was stored.
 */
export async function insertCountLine(
  tx: DatabaseClient,
  params: InsertCountLineParams,
): Promise<CountLine> {
  const { rows } = await tx.query<CountLineRow>(
    `INSERT INTO inventory_count_lines
       (id, variant_id, location_id, expected_quantity, counted_quantity,
        counted_by_user_id, counted_at, recorded_at, operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      params.id,
      params.variantId,
      params.locationId,
      params.expectedQuantity,
      params.countedQuantity,
      params.countedByUserId,
      params.countedAt,
      params.recordedAt,
      params.operationId,
    ],
  );
  const row = rows[0];
  // Unreachable: the insert either returns its row or throws.
  if (!row) throw new Error('Count line insert returned no row');
  return toCountLine(row);
}

/** Reads one count line, without locking. Used to answer a replayed command. */
export async function getCountLineById(db: Queryable, id: string): Promise<CountLine | null> {
  const { rows } = await db.query<CountLineRow>(
    `SELECT ${COLUMNS} FROM inventory_count_lines WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toCountLine(row) : null;
}

/**
 * Reads one count line **and locks it** for the rest of the transaction.
 *
 * The lock is what makes "is this discrepancy still unresolved?" a decision
 * rather than a guess. Two people accepting the same variance at the same
 * moment both arrive here; one waits, and by the time it reads the row the
 * other's reconciliation is committed and visible. Without it both would read
 * `OPEN`, both would post, and the shelf would be moved twice for one
 * discrepancy.
 *
 * `FOR UPDATE`, not `FOR SHARE`: the winner is going to write this row.
 */
export async function lockCountLine(tx: DatabaseClient, id: string): Promise<CountLine | null> {
  const { rows } = await tx.query<CountLineRow>(
    `SELECT ${COLUMNS} FROM inventory_count_lines WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  return row ? toCountLine(row) : null;
}

export interface ReconcileCountLineParams {
  id: string;
  reason: CountReconciliationReason;
  note: string | null;
  reconciledByUserId: string;
  reconciledAt: Date;
  reconciliationOperationId: string;
  reconciliationMovementId: string;
}

/**
 * Settles a discrepancy: the decision, who made it, when, and the movement it
 * posted.
 *
 * **The only UPDATE in this file, and it writes only reconciliation columns.**
 * Everything the observation recorded is untouched, and the trigger from 0013
 * would refuse this statement if it tried otherwise — including on a row that
 * has already been reconciled, which is what makes the decision one-way in the
 * database rather than by convention.
 *
 * `WHERE ... AND reconciled_at IS NULL` is belt to the lock's braces: the caller
 * has already locked the row and checked its status, and if that ever stops
 * being true this statement changes nothing rather than overwriting somebody
 * else's decision.
 */
export async function reconcileCountLine(
  tx: DatabaseClient,
  params: ReconcileCountLineParams,
): Promise<CountLine> {
  const { rows } = await tx.query<CountLineRow>(
    `UPDATE inventory_count_lines
        SET reconciliation_reason       = $2,
            reconciliation_note         = $3,
            reconciled_by_user_id       = $4,
            reconciled_at               = $5,
            reconciliation_operation_id = $6,
            reconciliation_movement_id  = $7
      WHERE id = $1 AND reconciled_at IS NULL
      RETURNING ${COLUMNS}`,
    [
      params.id,
      params.reason,
      params.note,
      params.reconciledByUserId,
      params.reconciledAt,
      params.reconciliationOperationId,
      params.reconciliationMovementId,
    ],
  );
  const row = rows[0];
  // The caller located and locked this row earlier in the same transaction and
  // found it unresolved, so exactly one row must be here to settle. Zero means
  // the movement was posted and the count was not settled with it — the one
  // outcome this workflow must never leave behind (INV-9). Throwing rolls the
  // movement back with it.
  if (!row) {
    throw new AppError(
      'INTERNAL',
      `Count ${params.id} could not be settled after its reconciliation movement was posted. ` +
        'Refusing to leave a stock change without the count that explains it.',
    );
  }
  return toCountLine(row);
}

export interface CountFilter {
  status?: CountStatus | undefined;
  variantId?: string | undefined;
  locationId?: string | undefined;
  /** Inclusive bounds on `recorded_at`, the column the feed is ordered by. */
  recordedFrom?: Date | undefined;
  recordedTo?: Date | undefined;
  /** Resume strictly after this position. */
  after?: { recordedAt: string; id: string } | undefined;
  /** How many rows to return. The caller asks for one more than a page. */
  limit: number;
}

/**
 * One page of count evidence, newest recorded first.
 *
 * Ordered and paginated exactly as the movement feed is — `(recorded_at DESC,
 * id DESC)` with a row-value keyset comparison — because it is the same kind of
 * append-mostly feed with the same requirement: a count recorded while somebody
 * is reading page four must not shift a row across a page boundary. See PR 4's
 * repository for the full reasoning; it is not repeated here.
 *
 * **Nothing here filters by lifecycle or by whether a location is still open.**
 * A count of merchandise the shop has since archived, on a shelf it has since
 * closed, is exactly the record somebody goes looking for. Present-tense
 * operational filters belong to present-tense operational views.
 */
export async function listCountLines(db: Queryable, filter: CountFilter): Promise<CountLine[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.status !== undefined) conditions.push(`status = ${bind(filter.status)}`);
  if (filter.variantId !== undefined) conditions.push(`variant_id = ${bind(filter.variantId)}`);
  if (filter.locationId !== undefined) conditions.push(`location_id = ${bind(filter.locationId)}`);
  if (filter.recordedFrom !== undefined) {
    conditions.push(`recorded_at >= ${bind(filter.recordedFrom)}`);
  }
  if (filter.recordedTo !== undefined) {
    conditions.push(`recorded_at <= ${bind(filter.recordedTo)}`);
  }
  if (filter.after !== undefined) {
    conditions.push(
      `(recorded_at, id) < (${bind(filter.after.recordedAt)}::timestamptz, ${bind(filter.after.id)}::uuid)`,
    );
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  const { rows } = await db.query<CountLineRow>(
    `SELECT ${COLUMNS}
       FROM inventory_count_lines
      ${where}
      ORDER BY recorded_at DESC, id DESC
      LIMIT ${bind(filter.limit)}`,
    params,
  );

  return rows.map(toCountLine);
}

function toCountLine(row: CountLineRow): CountLine {
  return {
    id: row.id,
    variantId: row.variant_id,
    locationId: row.location_id,
    expectedQuantity: row.expected_quantity,
    countedQuantity: row.counted_quantity,
    variance: row.variance,
    countedByUserId: row.counted_by_user_id,
    countedAt: row.counted_at,
    recordedAt: row.recorded_at,
    recordedAtExact: row.recorded_at_exact,
    operationId: row.operation_id,
    status: row.status,
    reconciliationReason: row.reconciliation_reason,
    reconciliationNote: row.reconciliation_note,
    reconciledByUserId: row.reconciled_by_user_id,
    reconciledAt: row.reconciled_at,
    reconciliationOperationId: row.reconciliation_operation_id,
    reconciliationMovementId: row.reconciliation_movement_id,
  };
}
