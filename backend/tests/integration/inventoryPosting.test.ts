import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLedgerService,
  type LedgerService,
  type PostMovementCommand,
} from '../../src/modules/inventory/index.js';
import { AppError } from '../../src/platform/http/errors.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * The internal posting engine, driven against real PostgreSQL.
 *
 * There is no HTTP surface to test through — by design, this PR adds none — so
 * these tests call the service directly, which is exactly how the receiving,
 * adjustment, and count workflows will call it later.
 *
 * Isolation: posted movements can never be deleted, so each test that posts
 * works on its own freshly created (variant, location) chain.
 */

const OCCURRED_AT = new Date('2026-08-03T09:30:00.000Z');
const RECORDED_AT = new Date('2026-08-03T09:30:05.000Z');

let db: TestDatabase;
let ledger: LedgerService;

interface Chain {
  variantId: string;
  locationId: string;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-P${skuCounter.toString().padStart(7, '0')}`;
}

/** A fresh product, variant, and location: one isolated movement chain. */
async function newChain(): Promise<Chain> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1, 'Posting fixture', $2, $2)`,
    [productId, RECORDED_AT],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
     VALUES ($1, $2, $3, '[]', $4, $4)`,
    [variantId, productId, nextSku(), RECORDED_AT],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, 'Posting fixture location', false, true, $2, $2)`,
    [locationId, RECORDED_AT],
  );

  return { variantId, locationId };
}

/** A valid receipt command, with anything the test cares about overridden. */
function command(chain: Chain, overrides: Partial<PostMovementCommand> = {}): PostMovementCommand {
  return {
    movementId: newId(),
    operationId: newId(),
    operationType: 'inventory.post_movement',
    requestHash: 'a'.repeat(64),
    variantId: chain.variantId,
    locationId: chain.locationId,
    movementType: 'RECEIPT',
    quantityDelta: 5,
    reasonCode: null,
    note: null,
    userId: newId(),
    deviceId: newId(),
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

/** Posts and expects an AppError, returning it for further assertions. */
async function postFails(input: PostMovementCommand): Promise<AppError> {
  let thrown: unknown;
  try {
    await ledger.postMovement(input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  return thrown as AppError;
}

interface BalanceRow {
  quantity_on_hand: number;
  last_movement_id: string | null;
  updated_at: Date;
}

async function readBalance(chain: Chain): Promise<BalanceRow | undefined> {
  const { rows } = await db.pool.query<BalanceRow>(
    `SELECT quantity_on_hand, last_movement_id, updated_at
       FROM inventory_balances WHERE variant_id = $1 AND location_id = $2`,
    [chain.variantId, chain.locationId],
  );
  return rows[0];
}

async function countMovements(chain: Chain): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM inventory_movements
      WHERE variant_id = $1 AND location_id = $2`,
    [chain.variantId, chain.locationId],
  );
  return Number(rows[0]!.count);
}

async function countOperations(operationId: string): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM operations WHERE id = $1`,
    [operationId],
  );
  return Number(rows[0]!.count);
}

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = createLedgerService({ pool: db.pool });
});

afterAll(async () => {
  await db.drop();
});

describe('posting onto an empty chain', () => {
  it('starts from zero and records no predecessor', async () => {
    const chain = await newChain();
    const movement = await ledger.postMovement(command(chain, { quantityDelta: 5 }));

    expect(movement.quantityBefore).toBe(0);
    expect(movement.quantityAfter).toBe(5);
    expect(movement.previousMovementId).toBeNull();
    expect(movement.reversesMovementId).toBeNull();
  });

  it('creates the balance row lazily, only once stock moves', async () => {
    const chain = await newChain();
    expect(await readBalance(chain)).toBeUndefined();

    await ledger.postMovement(command(chain, { quantityDelta: 3 }));

    const balance = await readBalance(chain);
    expect(balance).toBeDefined();
    expect(balance!.quantity_on_hand).toBe(3);
  });

  it('leaves the movement and the balance in agreement', async () => {
    const chain = await newChain();
    const movement = await ledger.postMovement(command(chain, { quantityDelta: 8 }));

    const balance = await readBalance(chain);
    expect(balance!.quantity_on_hand).toBe(movement.quantityAfter);
    expect(balance!.last_movement_id).toBe(movement.id);
    expect(balance!.updated_at.toISOString()).toBe(RECORDED_AT.toISOString());
  });

  it('records the operation and points it at the movement it produced', async () => {
    const chain = await newChain();
    const input = command(chain, { quantityDelta: 2 });
    const movement = await ledger.postMovement(input);

    const { rows } = await db.pool.query<{
      operation_type: string;
      request_hash: string;
      result_resource_type: string | null;
      result_resource_id: string | null;
      created_at: Date;
    }>(
      `SELECT operation_type, request_hash, result_resource_type, result_resource_id, created_at
         FROM operations WHERE id = $1`,
      [input.operationId],
    );

    expect(rows[0]).toMatchObject({
      operation_type: input.operationType,
      request_hash: input.requestHash,
      result_resource_type: 'inventory_movement',
      result_resource_id: movement.id,
    });
    expect(rows[0]!.created_at.toISOString()).toBe(RECORDED_AT.toISOString());
  });
});

describe('posting onto an existing chain', () => {
  it('continues from the previous movement and the current balance', async () => {
    const chain = await newChain();
    const first = await ledger.postMovement(command(chain, { quantityDelta: 5 }));
    const second = await ledger.postMovement(
      command(chain, {
        movementType: 'ADJUSTMENT_OUT',
        quantityDelta: -2,
        reasonCode: 'DAMAGE',
      }),
    );

    expect(second.quantityBefore).toBe(5);
    expect(second.quantityAfter).toBe(3);
    expect(second.previousMovementId).toBe(first.id);

    const balance = await readBalance(chain);
    expect(balance!.quantity_on_hand).toBe(3);
    expect(balance!.last_movement_id).toBe(second.id);
  });

  it('keeps the chain and the projection equal over several movements', async () => {
    const chain = await newChain();
    await ledger.postMovement(command(chain, { quantityDelta: 10 }));
    await ledger.postMovement(
      command(chain, { movementType: 'ADJUSTMENT_IN', quantityDelta: 4, reasonCode: 'FOUND' }),
    );
    await ledger.postMovement(
      command(chain, { movementType: 'COUNT_RECONCILIATION', quantityDelta: -3 }),
    );

    const { rows } = await db.pool.query<{ total: string }>(
      `SELECT coalesce(sum(quantity_delta), 0)::text AS total FROM inventory_movements
        WHERE variant_id = $1 AND location_id = $2`,
      [chain.variantId, chain.locationId],
    );
    const balance = await readBalance(chain);
    expect(Number(rows[0]!.total)).toBe(11);
    expect(balance!.quantity_on_hand).toBe(11);
  });
});

describe('direction rules', () => {
  it('rejects a RECEIPT with a negative delta', async () => {
    const chain = await newChain();
    const error = await postFails(command(chain, { quantityDelta: -5 }));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details?.[0]?.path).toBe('quantityDelta');
    expect(await countMovements(chain)).toBe(0);
  });

  it('rejects an ADJUSTMENT_IN with a negative delta', async () => {
    const chain = await newChain();
    const error = await postFails(
      command(chain, { movementType: 'ADJUSTMENT_IN', quantityDelta: -1, reasonCode: 'FOUND' }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(await countMovements(chain)).toBe(0);
  });

  it('rejects an ADJUSTMENT_OUT with a positive delta', async () => {
    const chain = await newChain();
    await ledger.postMovement(command(chain, { quantityDelta: 5 }));
    const error = await postFails(
      command(chain, { movementType: 'ADJUSTMENT_OUT', quantityDelta: 1, reasonCode: 'DAMAGE' }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(await countMovements(chain)).toBe(1);
  });

  it('accepts a COUNT_RECONCILIATION in either direction', async () => {
    const up = await newChain();
    const found = await ledger.postMovement(
      command(up, { movementType: 'COUNT_RECONCILIATION', quantityDelta: 4 }),
    );
    expect(found.quantityAfter).toBe(4);

    const down = await newChain();
    await ledger.postMovement(command(down, { quantityDelta: 10 }));
    const missing = await ledger.postMovement(
      command(down, { movementType: 'COUNT_RECONCILIATION', quantityDelta: -6 }),
    );
    expect(missing.quantityAfter).toBe(4);
  });

  it('rejects a zero delta', async () => {
    const chain = await newChain();
    const error = await postFails(command(chain, { quantityDelta: 0 }));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(await countMovements(chain)).toBe(0);
  });

  it('rejects a fractional delta', async () => {
    const chain = await newChain();
    const error = await postFails(command(chain, { quantityDelta: 1.5 }));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(await countMovements(chain)).toBe(0);
  });
});

describe('the stock floor', () => {
  it('refuses a movement that would drive stock below zero', async () => {
    const chain = await newChain();
    await ledger.postMovement(command(chain, { quantityDelta: 2 }));

    const error = await postFails(
      command(chain, {
        movementType: 'ADJUSTMENT_OUT',
        quantityDelta: -3,
        reasonCode: 'DAMAGE',
      }),
    );

    expect(error.code).toBe('INSUFFICIENT_STOCK');
    expect(error.status).toBe(422);
  });

  it('commits nothing at all when the stock floor rejects a movement', async () => {
    const chain = await newChain();
    const opening = await ledger.postMovement(command(chain, { quantityDelta: 2 }));

    const rejected = command(chain, {
      movementType: 'ADJUSTMENT_OUT',
      quantityDelta: -3,
      reasonCode: 'DAMAGE',
    });
    await postFails(rejected);

    // No operation, no movement, and the balance is exactly where it was.
    expect(await countOperations(rejected.operationId)).toBe(0);
    expect(await countMovements(chain)).toBe(1);
    const balance = await readBalance(chain);
    expect(balance!.quantity_on_hand).toBe(2);
    expect(balance!.last_movement_id).toBe(opening.id);
  });

  it('rolls back the lazily created balance row too', async () => {
    // The first movement on a chain creates the zero balance inside the same
    // transaction, so a failure must leave no balance row behind either.
    const chain = await newChain();
    const rejected = command(chain, {
      movementType: 'COUNT_RECONCILIATION',
      quantityDelta: -1,
    });
    const error = await postFails(rejected);

    expect(error.code).toBe('INSUFFICIENT_STOCK');
    expect(await readBalance(chain)).toBeUndefined();
    expect(await countOperations(rejected.operationId)).toBe(0);
  });
});

describe('reason codes', () => {
  it('requires a reason code for an adjustment', async () => {
    const chain = await newChain();
    const error = await postFails(
      command(chain, { movementType: 'ADJUSTMENT_IN', quantityDelta: 1, reasonCode: null }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details?.some((d) => d.path === 'reasonCode')).toBe(true);
    expect(await countMovements(chain)).toBe(0);
  });

  it('treats a blank reason code as a missing one', async () => {
    const chain = await newChain();
    const error = await postFails(
      command(chain, { movementType: 'ADJUSTMENT_OUT', quantityDelta: -1, reasonCode: '   ' }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details?.some((d) => d.path === 'reasonCode')).toBe(true);
  });

  it('does not require a reason code for a receipt or a count', async () => {
    const chain = await newChain();
    await expect(ledger.postMovement(command(chain, { quantityDelta: 1 }))).resolves.toBeTruthy();
    await expect(
      ledger.postMovement(
        command(chain, { movementType: 'COUNT_RECONCILIATION', quantityDelta: 2 }),
      ),
    ).resolves.toBeTruthy();
  });
});

describe('reversal', () => {
  it('rejects REVERSAL as not implemented', async () => {
    const chain = await newChain();
    const original = await ledger.postMovement(command(chain, { quantityDelta: 5 }));

    // The command type excludes REVERSAL; an untyped caller is the only way to
    // get here, which is exactly what this guard is for.
    const reversal = {
      ...command(chain, { quantityDelta: -5 }),
      movementType: 'REVERSAL',
    } as unknown as PostMovementCommand;

    const error = await postFails(reversal);
    expect(error.message).toMatch(/not implemented/i);
    expect(await countMovements(chain)).toBe(1);
    const balance = await readBalance(chain);
    expect(balance!.last_movement_id).toBe(original.id);
  });

  it('rejects an unknown movement type', async () => {
    const chain = await newChain();
    const unknown = {
      ...command(chain),
      movementType: 'TRANSFER',
    } as unknown as PostMovementCommand;

    const error = await postFails(unknown);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(await countMovements(chain)).toBe(0);
  });
});

describe('idempotency', () => {
  it('returns the original movement when the same command is retried', async () => {
    const chain = await newChain();
    const first = command(chain, { quantityDelta: 5 });
    const posted = await ledger.postMovement(first);

    // A retry carries the same operation id, type, and hash. The movement id
    // differs here on purpose: the answer must be the stored movement, not a
    // freshly posted one that happens to look similar.
    const retry = await ledger.postMovement({ ...first, movementId: newId() });

    expect(retry.id).toBe(posted.id);
    expect(retry.quantityBefore).toBe(0);
    expect(retry.quantityAfter).toBe(5);
  });

  it('posts no second movement and does not move the balance on a retry', async () => {
    const chain = await newChain();
    const first = command(chain, { quantityDelta: 5 });
    await ledger.postMovement(first);
    await ledger.postMovement({ ...first, movementId: newId() });
    await ledger.postMovement({ ...first, movementId: newId() });

    expect(await countMovements(chain)).toBe(1);
    const balance = await readBalance(chain);
    expect(balance!.quantity_on_hand).toBe(5);
  });

  it('rejects an operation id reused with a different request hash', async () => {
    const chain = await newChain();
    const first = command(chain, { quantityDelta: 5 });
    await ledger.postMovement(first);

    const error = await postFails({
      ...first,
      movementId: newId(),
      requestHash: 'b'.repeat(64),
      quantityDelta: 50,
    });

    expect(error.code).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect(error.status).toBe(409);
    expect(await countMovements(chain)).toBe(1);
  });

  it('rejects an operation id reused with a different operation type', async () => {
    const chain = await newChain();
    const first = command(chain, { quantityDelta: 5 });
    await ledger.postMovement(first);

    const error = await postFails({
      ...first,
      movementId: newId(),
      operationType: 'inventory.something_else',
    });

    expect(error.code).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect(error.status).toBe(409);
    expect(await countMovements(chain)).toBe(1);
  });
});

describe('an operation whose result is missing or inconsistent', () => {
  /** Writes an operations row directly, as if some other writer had claimed it. */
  async function seedOperation(
    input: PostMovementCommand,
    result: { type: string; id: string } | null,
  ): Promise<void> {
    await db.pool.query(
      `INSERT INTO operations
         (id, operation_type, request_hash, result_resource_type, result_resource_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.operationId,
        input.operationType,
        input.requestHash,
        result?.type ?? null,
        result?.id ?? null,
        RECORDED_AT,
      ],
    );
  }

  it('fails safely when the operation records no result at all', async () => {
    const chain = await newChain();
    const input = command(chain, { quantityDelta: 5 });
    await seedOperation(input, null);

    const error = await postFails(input);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toMatch(/refusing to post a second movement/i);
    expect(await countMovements(chain)).toBe(0);
  });

  it('fails safely when the result points at a movement that does not exist', async () => {
    const chain = await newChain();
    const input = command(chain, { quantityDelta: 5 });
    await seedOperation(input, { type: 'inventory_movement', id: newId() });

    const error = await postFails(input);
    expect(error.code).toBe('INTERNAL');
    expect(await countMovements(chain)).toBe(0);
  });

  it('fails safely when the result points at some other kind of resource', async () => {
    const chain = await newChain();
    const input = command(chain, { quantityDelta: 5 });
    await seedOperation(input, { type: 'product', id: newId() });

    const error = await postFails(input);
    expect(error.code).toBe('INTERNAL');
    expect(await countMovements(chain)).toBe(0);
  });

  it('fails safely when the result points at another operation’s movement', async () => {
    // Operation A posts legitimately. Operation B is then made to point at A's
    // movement — returning it would report a stock change B never made.
    const chain = await newChain();
    const operationA = command(chain, { quantityDelta: 5 });
    const posted = await ledger.postMovement(operationA);

    const operationB = command(chain, { quantityDelta: 5 });
    await seedOperation(operationB, { type: 'inventory_movement', id: posted.id });

    const error = await postFails(operationB);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toMatch(/posted by operation/i);

    // No second movement, and the balance is exactly where operation A left it.
    expect(await countMovements(chain)).toBe(1);
    const balance = await readBalance(chain);
    expect(balance!.quantity_on_hand).toBe(5);
    expect(balance!.last_movement_id).toBe(posted.id);
  });
});

describe('foreign-key failures', () => {
  it('rolls the transaction back when the variant does not exist', async () => {
    const chain = await newChain();
    const input = command({ variantId: newId(), locationId: chain.locationId });

    await expect(ledger.postMovement(input)).rejects.toMatchObject({ code: '23503' });
    expect(await countOperations(input.operationId)).toBe(0);
  });

  it('rolls the transaction back when the location does not exist', async () => {
    const chain = await newChain();
    const input = command({ variantId: chain.variantId, locationId: newId() });

    await expect(ledger.postMovement(input)).rejects.toMatchObject({ code: '23503' });
    expect(await countOperations(input.operationId)).toBe(0);
    expect(await countMovements(chain)).toBe(0);
  });
});

describe('the returned movement', () => {
  it('is exactly what the database persisted', async () => {
    const chain = await newChain();
    const input = command(chain, {
      movementType: 'ADJUSTMENT_IN',
      quantityDelta: 6,
      reasonCode: 'FOUND_STOCK',
      note: 'Recount after delivery',
    });
    const movement = await ledger.postMovement(input);

    const { rows } = await db.pool.query<Record<string, unknown>>(
      `SELECT id, variant_id, location_id, movement_type,
              quantity_delta, quantity_before, quantity_after,
              previous_movement_id, reverses_movement_id, operation_id,
              reason_code, note, user_id, device_id, occurred_at, recorded_at
         FROM inventory_movements WHERE id = $1`,
      [input.movementId],
    );
    const row = rows[0]!;

    expect(movement).toEqual({
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
    });
    // And the fields the caller never supplied are the ones the engine derived.
    expect(movement.quantityBefore).toBe(0);
    expect(movement.quantityAfter).toBe(6);
    expect(movement.reversesMovementId).toBeNull();
    expect(movement.operationId).toBe(input.operationId);
  });
});
