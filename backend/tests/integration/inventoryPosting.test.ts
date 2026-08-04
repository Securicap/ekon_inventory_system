import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLedgerService,
  type LedgerService,
  type PostMovementCommand,
} from '../../src/modules/inventory/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { AppError } from '../../src/platform/http/errors.js';
import { isUuid, newId } from '../../src/platform/ids/uuidv7.js';
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
 *
 * The engine owns the movement id and the recorded time, so the suite injects
 * both dependencies rather than passing them in commands: a fixed clock, and an
 * id generator that records every id the engine asked for.
 */

/** Business time: when the stock physically moved. The caller's to state. */
const OCCURRED_AT = new Date('2026-08-04T10:00:00.000Z');
/** Server time: two hours later, so the two can never be confused for one. */
const RECORDED_AT = new Date('2026-08-04T12:00:00.000Z');

/**
 * The server clock the engine reads. Re-created before each test so one test
 * advancing it cannot leak into the next; the service reads it through a stable
 * indirection, since it is constructed once.
 */
let clock = fixedClock(RECORDED_AT);

/**
 * Every movement id the engine has minted, in order. The engine generates one
 * only when it is about to post, so this doubles as a call counter.
 */
let generatedIds: string[] = [];
/** Ids a test wants the engine to mint next, consumed in order. */
let pinnedIds: string[] = [];

function generateId(): string {
  const id = pinnedIds.shift() ?? newId();
  generatedIds.push(id);
  return id;
}

/** Pins the next id the engine will mint, and returns it. */
function pinNextId(id: string = newId()): string {
  pinnedIds.push(id);
  return id;
}

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

/**
 * A valid receipt command, with anything the test cares about overridden.
 *
 * It describes a business event and nothing else: no movement id, and no
 * recorded time. Both are the engine's.
 */
function command(chain: Chain, overrides: Partial<PostMovementCommand> = {}): PostMovementCommand {
  return {
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
    occurredAt: OCCURRED_AT,
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

interface OperationRow {
  operation_type: string;
  request_hash: string;
  result_resource_type: string | null;
  result_resource_id: string | null;
  created_at: Date;
}

async function readOperation(operationId: string): Promise<OperationRow | undefined> {
  const { rows } = await db.pool.query<OperationRow>(
    `SELECT operation_type, request_hash, result_resource_type, result_resource_id, created_at
       FROM operations WHERE id = $1`,
    [operationId],
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
  ledger = createLedgerService({ pool: db.pool, clock: { now: () => clock.now() }, generateId });
});

beforeEach(() => {
  clock = fixedClock(RECORDED_AT);
  generatedIds = [];
  pinnedIds = [];
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

    const operation = await readOperation(input.operationId);

    expect(operation).toMatchObject({
      operation_type: input.operationType,
      request_hash: input.requestHash,
      result_resource_type: 'inventory_movement',
      result_resource_id: movement.id,
    });
    expect(operation!.created_at.toISOString()).toBe(RECORDED_AT.toISOString());
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

    // A retry is the identical command again — the caller kept no movement id
    // and has nothing else to send. The answer must be the stored movement.
    const retry = await ledger.postMovement({ ...first });

    expect(retry.id).toBe(posted.id);
    expect(retry.quantityBefore).toBe(0);
    expect(retry.quantityAfter).toBe(5);
  });

  it('posts no second movement and does not move the balance on a retry', async () => {
    const chain = await newChain();
    const first = command(chain, { quantityDelta: 5 });
    await ledger.postMovement(first);
    await ledger.postMovement({ ...first });
    await ledger.postMovement({ ...first });

    expect(await countMovements(chain)).toBe(1);
    const balance = await readBalance(chain);
    expect(balance!.quantity_on_hand).toBe(5);
  });

  it('mints no movement id for a replay, and answers with the original', async () => {
    const chain = await newChain();
    const input = command(chain, { quantityDelta: 5 });
    const posted = await ledger.postMovement(input);

    // One post, one id. The engine asks for an id only after it has claimed the
    // operation, so a replay — which never claims — must ask for none.
    expect(generatedIds).toEqual([posted.id]);

    const replayed = await ledger.postMovement({ ...input });
    const replayedAgain = await ledger.postMovement({ ...input });

    expect(generatedIds).toEqual([posted.id]);
    expect(replayed.id).toBe(posted.id);
    expect(replayedAgain.id).toBe(posted.id);
  });

  it('leaves the original movement, balance, and timestamps untouched on a replay', async () => {
    const chain = await newChain();
    const input = command(chain, { quantityDelta: 5 });
    const posted = await ledger.postMovement(input);

    // The clock keeps moving between attempts. The engine still samples it —
    // the operation claim needs a timestamp before the outcome is known — but a
    // replay writes nothing, so no persisted timestamp may move with it.
    clock.advance(60 * 60 * 1000);
    const replayed = await ledger.postMovement({ ...input });

    expect(replayed).toEqual(posted);
    expect(replayed.recordedAt.toISOString()).toBe(RECORDED_AT.toISOString());
    expect(replayed.occurredAt.toISOString()).toBe(OCCURRED_AT.toISOString());
    expect(await countMovements(chain)).toBe(1);

    const balance = await readBalance(chain);
    expect(balance!.quantity_on_hand).toBe(5);
    expect(balance!.last_movement_id).toBe(posted.id);
    expect(balance!.updated_at.toISOString()).toBe(RECORDED_AT.toISOString());

    const operation = await readOperation(input.operationId);
    expect(operation!.result_resource_id).toBe(posted.id);
    expect(operation!.created_at.toISOString()).toBe(RECORDED_AT.toISOString());
  });

  it('rejects an operation id reused with a different request hash', async () => {
    const chain = await newChain();
    const first = command(chain, { quantityDelta: 5 });
    await ledger.postMovement(first);

    const error = await postFails({
      ...first,
      requestHash: 'b'.repeat(64),
      quantityDelta: 50,
    });

    expect(error.code).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect(error.status).toBe(409);
    expect(await countMovements(chain)).toBe(1);
    // The refused command minted nothing: one post, one id.
    expect(generatedIds).toHaveLength(1);
  });

  it('rejects an operation id reused with a different operation type', async () => {
    const chain = await newChain();
    const first = command(chain, { quantityDelta: 5 });
    await ledger.postMovement(first);

    const error = await postFails({
      ...first,
      operationType: 'inventory.something_else',
    });

    expect(error.code).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect(error.status).toBe(409);
    expect(await countMovements(chain)).toBe(1);
    expect(generatedIds).toHaveLength(1);
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
              reason_code, note, user_id, occurred_at, recorded_at
         FROM inventory_movements WHERE id = $1`,
      [movement.id],
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
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
    });
    // And the fields the caller never supplied are the ones the engine derived.
    expect(movement.quantityBefore).toBe(0);
    expect(movement.quantityAfter).toBe(6);
    expect(movement.reversesMovementId).toBeNull();
    expect(movement.operationId).toBe(input.operationId);
    // Including its permanent identity and the time the system recorded it.
    expect(movement.id).toBe(generatedIds[0]);
    expect(movement.recordedAt.toISOString()).toBe(RECORDED_AT.toISOString());
  });
});

describe('the movement id the engine generates', () => {
  it('is the id persisted, returned, projected, and pointed at by the operation', async () => {
    const chain = await newChain();
    const pinned = pinNextId();

    const input = command(chain, { quantityDelta: 4 });
    const movement = await ledger.postMovement(input);

    // Asked for exactly once, and for this posting only.
    expect(generatedIds).toEqual([pinned]);

    // Returned to the caller...
    expect(movement.id).toBe(pinned);
    // ...persisted as the movement's primary key...
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM inventory_movements WHERE variant_id = $1 AND location_id = $2`,
      [chain.variantId, chain.locationId],
    );
    expect(rows.map((row) => row.id)).toEqual([pinned]);
    // ...carried by the balance projection...
    const balance = await readBalance(chain);
    expect(balance!.last_movement_id).toBe(pinned);
    // ...and recorded as the operation's result, which is what a retry reads.
    const operation = await readOperation(input.operationId);
    expect(operation).toMatchObject({
      result_resource_type: 'inventory_movement',
      result_resource_id: pinned,
    });
  });

  it('is a fresh UUID per movement, and never the operation id', async () => {
    const chain = await newChain();
    const first = command(chain, { quantityDelta: 4 });
    const second = command(chain, { quantityDelta: 3 });

    const one = await ledger.postMovement(first);
    const two = await ledger.postMovement(second);

    expect(isUuid(one.id)).toBe(true);
    expect(isUuid(two.id)).toBe(true);
    expect(one.id).not.toBe(two.id);
    // Not derived from, and not reused from, the operation that produced it.
    expect(one.id).not.toBe(first.operationId);
    expect(two.id).not.toBe(second.operationId);
  });

  it('defaults to the application UUIDv7 generator when none is injected', async () => {
    // The generator is an injection point for tests, not a required dependency:
    // a caller that supplies only a pool and a clock still gets real ids.
    const defaultLedger = createLedgerService({ pool: db.pool, clock });
    const chain = await newChain();

    const movement = await defaultLedger.postMovement(command(chain, { quantityDelta: 2 }));

    expect(isUuid(movement.id)).toBe(true);
    // The suite's generator was not consulted for it.
    expect(generatedIds).toEqual([]);
  });
});

describe('the recorded time the engine stamps', () => {
  it('comes from the injected clock and stamps operation, movement, and balance alike', async () => {
    const chain = await newChain();
    const input = command(chain, { quantityDelta: 7 });

    const movement = await ledger.postMovement(input);

    const operation = await readOperation(input.operationId);
    const balance = await readBalance(chain);

    // One reading of the clock, written in three places.
    expect(movement.recordedAt.toISOString()).toBe(RECORDED_AT.toISOString());
    expect(operation!.created_at.toISOString()).toBe(RECORDED_AT.toISOString());
    expect(balance!.updated_at.toISOString()).toBe(RECORDED_AT.toISOString());
  });

  it('is the server’s, while occurredAt stays the caller’s business time', async () => {
    const chain = await newChain();
    // Counted in the morning, entered in the afternoon. Both times are true,
    // and they are not the same fact.
    const input = command(chain, { quantityDelta: 7, occurredAt: OCCURRED_AT });

    const movement = await ledger.postMovement(input);

    expect(movement.occurredAt.toISOString()).toBe(OCCURRED_AT.toISOString());
    expect(movement.recordedAt.toISOString()).toBe(RECORDED_AT.toISOString());
    expect(movement.occurredAt.getTime()).toBeLessThan(movement.recordedAt.getTime());
  });

  it('accepts a business time long before the server recorded it', async () => {
    // A past `occurredAt` is a late entry, not an error. Timestamp policy — how
    // far back a given workflow will accept — belongs to that workflow.
    const chain = await newChain();
    const backdated = new Date('2026-07-01T08:15:00.000Z');

    const movement = await ledger.postMovement(
      command(chain, { quantityDelta: 7, occurredAt: backdated }),
    );

    expect(movement.occurredAt.toISOString()).toBe(backdated.toISOString());
    expect(movement.recordedAt.toISOString()).toBe(RECORDED_AT.toISOString());
  });

  it('advances with the clock, so each posting carries its own recorded time', async () => {
    const chain = await newChain();
    const first = await ledger.postMovement(command(chain, { quantityDelta: 2 }));

    clock.advance(90_000);
    const second = await ledger.postMovement(command(chain, { quantityDelta: 3 }));

    expect(first.recordedAt.toISOString()).toBe(RECORDED_AT.toISOString());
    expect(second.recordedAt.getTime()).toBe(RECORDED_AT.getTime() + 90_000);
    // The balance carries the newer stamp; the first movement keeps its own.
    const balance = await readBalance(chain);
    expect(balance!.updated_at.getTime()).toBe(RECORDED_AT.getTime() + 90_000);
  });
});

describe('a command that fails after claiming its operation', () => {
  it('persists neither the generated movement id nor anything else', async () => {
    const chain = await newChain();
    const opening = await ledger.postMovement(command(chain, { quantityDelta: 2 }));

    const rejected = command(chain, {
      movementType: 'ADJUSTMENT_OUT',
      quantityDelta: -3,
      reasonCode: 'DAMAGE',
    });
    const error = await postFails(rejected);
    expect(error.code).toBe('INSUFFICIENT_STOCK');

    // The id was minted in memory — the claim succeeded before the stock floor
    // refused the movement — and then rolled back with everything else. A
    // generated UUID is cheap and is not recycled.
    expect(generatedIds).toHaveLength(2);
    const abandoned = generatedIds[1]!;
    expect(abandoned).not.toBe(opening.id);

    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements WHERE id = $1`,
      [abandoned],
    );
    expect(Number(rows[0]!.count)).toBe(0);
    expect(await countOperations(rejected.operationId)).toBe(0);
    expect(await countMovements(chain)).toBe(1);
    const balance = await readBalance(chain);
    expect(balance!.quantity_on_hand).toBe(2);
    expect(balance!.last_movement_id).toBe(opening.id);
  });
});
