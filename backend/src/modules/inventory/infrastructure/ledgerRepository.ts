import type { MovementType } from '@ekon/shared';
import type { DatabaseClient } from '../../../platform/db/pool.js';

/**
 * Ledger persistence: the `operations`, `inventory_movements`, and
 * `inventory_balances` tables. Hand-written SQL, typed row shapes kept internal
 * to the backend, and mapping done in one place.
 *
 * Every function here takes a transaction client, never the pool. That is not
 * an accident of the current call site: a movement insert, its balance update,
 * and its operation row have to commit together or not at all (INV-5), so there
 * is deliberately no pool-level variant to reach for.
 *
 * There is no update or delete of a movement row here, and there never will be
 * — the database refuses both (INV-1). Corrections are compensating movements.
 */

/** Marks an `operations` row whose result is an inventory movement. */
export const MOVEMENT_RESULT_RESOURCE_TYPE = 'inventory_movement';

/** An `operations` row as this module needs to read it back on a replay. */
export interface StoredOperation {
  id: string;
  operationType: string;
  requestHash: string;
  resultResourceType: string | null;
  resultResourceId: string | null;
}

/**
 * A persisted movement, as the rest of the backend sees it.
 *
 * Timestamps stay as `Date` rather than ISO strings: nothing about a movement
 * crosses the wire yet, so there is no shared wire type to map to. The HTTP
 * layer will do that mapping when it arrives, and will do it in one place.
 */
export interface PostedMovement {
  id: string;
  variantId: string;
  locationId: string;
  movementType: MovementType;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  previousMovementId: string | null;
  reversesMovementId: string | null;
  operationId: string;
  reasonCode: string | null;
  note: string | null;
  userId: string;
  deviceId: string;
  occurredAt: Date;
  recordedAt: Date;
}

/** The locked projection row a movement is calculated from. */
export interface LockedBalance {
  quantityOnHand: number;
  lastMovementId: string | null;
}

interface OperationRow {
  id: string;
  operation_type: string;
  request_hash: string;
  result_resource_type: string | null;
  result_resource_id: string | null;
}

interface MovementRow {
  id: string;
  variant_id: string;
  location_id: string;
  movement_type: MovementType;
  quantity_delta: number;
  quantity_before: number;
  quantity_after: number;
  previous_movement_id: string | null;
  reverses_movement_id: string | null;
  operation_id: string;
  reason_code: string | null;
  note: string | null;
  user_id: string;
  device_id: string;
  occurred_at: Date;
  recorded_at: Date;
}

interface BalanceRow {
  quantity_on_hand: number;
  last_movement_id: string | null;
}

export interface ClaimOperationParams {
  id: string;
  operationType: string;
  requestHash: string;
  createdAt: Date;
}

export interface InsertMovementParams {
  id: string;
  variantId: string;
  locationId: string;
  movementType: MovementType;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  previousMovementId: string | null;
  operationId: string;
  reasonCode: string | null;
  note: string | null;
  userId: string;
  deviceId: string;
  occurredAt: Date;
  recordedAt: Date;
}

export interface UpdateBalanceParams {
  variantId: string;
  locationId: string;
  quantityOnHand: number;
  lastMovementId: string;
  updatedAt: Date;
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

export async function getOperation(
  tx: DatabaseClient,
  id: string,
): Promise<StoredOperation | null> {
  const { rows } = await tx.query<OperationRow>(
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
 * Records which movement this operation produced, so a retry can return it
 * instead of posting again. The pointer only: never the request or the response
 * body, which would turn an idempotency key into a payload store.
 */
export async function completeOperation(
  tx: DatabaseClient,
  params: { id: string; movementId: string },
): Promise<void> {
  await tx.query(
    `UPDATE operations
        SET result_resource_type = $2,
            result_resource_id   = $3
      WHERE id = $1`,
    [params.id, MOVEMENT_RESULT_RESOURCE_TYPE, params.movementId],
  );
}

/**
 * Locks the balance row for one (variant, location) for the rest of the
 * transaction, so no other writer can read the same quantity and post from it.
 * Returns null when no row exists yet.
 */
export async function lockBalance(
  tx: DatabaseClient,
  variantId: string,
  locationId: string,
): Promise<LockedBalance | null> {
  const { rows } = await tx.query<BalanceRow>(
    `SELECT quantity_on_hand, last_movement_id
       FROM inventory_balances
      WHERE variant_id = $1 AND location_id = $2
      FOR UPDATE`,
    [variantId, locationId],
  );
  const row = rows[0];
  return row
    ? { quantityOnHand: row.quantity_on_hand, lastMovementId: row.last_movement_id }
    : null;
}

/**
 * Creates the zero balance for a (variant, location) that has never held stock.
 * `ON CONFLICT DO NOTHING` so a concurrent first writer is a no-op rather than
 * a failure; the caller re-reads under `FOR UPDATE` either way.
 */
export async function insertZeroBalance(
  tx: DatabaseClient,
  params: { variantId: string; locationId: string; updatedAt: Date },
): Promise<void> {
  await tx.query(
    `INSERT INTO inventory_balances
       (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
     VALUES ($1, $2, 0, NULL, $3)
     ON CONFLICT (variant_id, location_id) DO NOTHING`,
    [params.variantId, params.locationId, params.updatedAt],
  );
}

export async function updateBalance(
  tx: DatabaseClient,
  params: UpdateBalanceParams,
): Promise<void> {
  await tx.query(
    `UPDATE inventory_balances
        SET quantity_on_hand = $3,
            last_movement_id = $4,
            updated_at       = $5
      WHERE variant_id = $1 AND location_id = $2`,
    [
      params.variantId,
      params.locationId,
      params.quantityOnHand,
      params.lastMovementId,
      params.updatedAt,
    ],
  );
}

/**
 * Appends one movement and returns what the database actually stored, read back
 * with RETURNING rather than reconstructed from the parameters. If a constraint
 * or a default ever disagrees with what the service computed, the caller sees
 * the stored truth.
 *
 * `reverses_movement_id` is always NULL here: reversal posting is not
 * implemented, and this function is not where it will be bolted on.
 */
export async function insertMovement(
  tx: DatabaseClient,
  params: InsertMovementParams,
): Promise<PostedMovement> {
  const { rows } = await tx.query<MovementRow>(
    `INSERT INTO inventory_movements (
       id, variant_id, location_id, movement_type,
       quantity_delta, quantity_before, quantity_after,
       previous_movement_id, reverses_movement_id, operation_id,
       reason_code, note, user_id, device_id, occurred_at, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, variant_id, location_id, movement_type,
               quantity_delta, quantity_before, quantity_after,
               previous_movement_id, reverses_movement_id, operation_id,
               reason_code, note, user_id, device_id, occurred_at, recorded_at`,
    [
      params.id,
      params.variantId,
      params.locationId,
      params.movementType,
      params.quantityDelta,
      params.quantityBefore,
      params.quantityAfter,
      params.previousMovementId,
      params.operationId,
      params.reasonCode,
      params.note,
      params.userId,
      params.deviceId,
      params.occurredAt,
      params.recordedAt,
    ],
  );
  const row = rows[0];
  // Unreachable: the insert either returns its row or throws.
  if (!row) throw new Error('Movement insert returned no row');
  return toMovement(row);
}

/** Reads one movement back, used to answer a replayed operation. */
export async function getMovementById(
  tx: DatabaseClient,
  id: string,
): Promise<PostedMovement | null> {
  const { rows } = await tx.query<MovementRow>(
    `SELECT id, variant_id, location_id, movement_type,
            quantity_delta, quantity_before, quantity_after,
            previous_movement_id, reverses_movement_id, operation_id,
            reason_code, note, user_id, device_id, occurred_at, recorded_at
       FROM inventory_movements
      WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toMovement(row) : null;
}

function toMovement(row: MovementRow): PostedMovement {
  return {
    id: row.id,
    variantId: row.variant_id,
    locationId: row.location_id,
    movementType: row.movement_type,
    quantityDelta: row.quantity_delta,
    quantityBefore: row.quantity_before,
    quantityAfter: row.quantity_after,
    previousMovementId: row.previous_movement_id,
    reversesMovementId: row.reverses_movement_id,
    operationId: row.operation_id,
    reasonCode: row.reason_code,
    note: row.note,
    userId: row.user_id,
    deviceId: row.device_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}
