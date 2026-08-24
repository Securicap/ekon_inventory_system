import type { DatabaseClient, DatabasePool } from '../../../platform/db/pool.js';
import { AppError } from '../../../platform/http/errors.js';

/**
 * The `operations` table: idempotency, and nothing else.
 *
 * Extracted from the ledger's persistence when physical counts arrived, because
 * counts made it the second thing that needs it. Recording an observation moves
 * no stock and posts no movement, but it creates durable business evidence, and
 * a dropped connection must not leave two records of one shelf-check — so it
 * claims an operation exactly as a stock command does (INV-7).
 *
 * **This is not a new idempotency framework.** It is the one the posting engine
 * has used since 0005, moved somewhere both callers can reach and widened in
 * exactly one place: the result pointer now names its own resource type instead
 * of assuming `inventory_movement`. Nothing else about the mechanism changed,
 * and there is deliberately still no status column, attempt counter, request or
 * response payload, error column, or workflow state — those turn an idempotency
 * key into a job queue, and this is not a job queue.
 */

/** Read-only access: the pool, or a transaction already in progress. */
type Queryable = DatabasePool | DatabaseClient;

/** An `operations` row as a workflow needs to read it back on a replay. */
export interface StoredOperation {
  id: string;
  operationType: string;
  requestHash: string;
  resultResourceType: string | null;
  resultResourceId: string | null;
}

/**
 * How a caller names a command it may have sent before: the operation id, and
 * the two things that are compared against the stored claim.
 */
export interface OperationClaim {
  operationId: string;
  operationType: string;
  requestHash: string;
}

export interface ClaimOperationParams {
  id: string;
  operationType: string;
  requestHash: string;
  createdAt: Date;
}

/**
 * Claims the operation id. Returns true when this transaction owns the command,
 * false when it was already claimed — including by a concurrent transaction,
 * which `ON CONFLICT DO NOTHING` waits out before reporting the conflict.
 *
 * Insert-and-see, never check-then-insert: reading first and inserting after
 * leaves a window in which two transactions both believe they are the first,
 * and duplicate protection that races is not duplicate protection (INV-7).
 */
export async function claimOperation(
  tx: DatabaseClient,
  params: ClaimOperationParams,
): Promise<boolean> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO operations (id, operation_type, request_hash, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [params.id, params.operationType, params.requestHash, params.createdAt],
  );
  return rows.length === 1;
}

export async function getOperation(db: Queryable, id: string): Promise<StoredOperation | null> {
  const { rows } = await db.query<{
    id: string;
    operation_type: string;
    request_hash: string;
    result_resource_type: string | null;
    result_resource_id: string | null;
  }>(
    `SELECT id, operation_type, request_hash, result_resource_type, result_resource_id
       FROM operations
      WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        operationType: row.operation_type,
        requestHash: row.request_hash,
        resultResourceType: row.result_resource_type,
        resultResourceId: row.result_resource_id,
      }
    : null;
}

/**
 * Records what this operation produced, so a retry can be answered with it
 * instead of applying the command again.
 *
 * The pointer only: never the request or the response body, which would turn an
 * idempotency key into a payload store. The resource *type* is a parameter
 * because two things now claim operations and they produce different kinds of
 * result — a movement, or a count line.
 */
export async function completeOperation(
  tx: DatabaseClient,
  params: { id: string; resultResourceType: string; resultResourceId: string },
): Promise<void> {
  const result = await tx.query(
    `UPDATE operations
        SET result_resource_type = $2,
            result_resource_id   = $3
      WHERE id = $1`,
    [params.id, params.resultResourceType, params.resultResourceId],
  );
  // The caller claimed this operation a few statements ago in this same
  // transaction, so exactly one row must be here to stamp. Anything else means
  // the row was never claimed or no longer exists, and a command whose
  // operation records no result would be applied again by the next retry.
  if (result.rowCount !== 1) {
    throw new AppError(
      'INTERNAL',
      `Expected to update exactly one row for operation ${params.id} while recording its ` +
        `result, updated ${result.rowCount ?? 'unknown'}`,
    );
  }
}

/**
 * Refuses an operation id that was used for a different command.
 *
 * One comparison, in one place, for every workflow that claims an operation.
 * Both fields have to match: the type keeps a receipt and a removal that reused
 * an id apart even if their hashes happened to collide, and the hash is what
 * says the command itself is the same one.
 *
 * It reports a conflict about the **id**, not about the resource — one
 * operation id has been used for two different commands, and answering with
 * anything about the merchandise would send somebody to fix the wrong thing.
 */
export function assertOperationMatchesClaim(
  existing: StoredOperation,
  claim: OperationClaim,
): void {
  if (existing.operationType !== claim.operationType) {
    throw replayedWithDifferentRequest(
      claim.operationId,
      `operation type ${existing.operationType} does not match ${claim.operationType}`,
    );
  }

  if (existing.requestHash !== claim.requestHash) {
    throw replayedWithDifferentRequest(
      claim.operationId,
      'request hash does not match the original request',
    );
  }
}

function replayedWithDifferentRequest(operationId: string, detail: string): AppError {
  return new AppError(
    'OPERATION_REPLAYED_WITH_DIFFERENT_BODY',
    `Operation ${operationId} was already used for a different request: ${detail}`,
  );
}
