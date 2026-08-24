import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOVEMENT_TYPES, REASON_REQUIRED_MOVEMENT_TYPES } from '@ekon/shared';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0005 — the ledger core.
 *
 * These tests exercise the database, not a service: there is no posting engine
 * yet, and the point of this PR is that the invariants hold even against raw
 * SQL. Every assertion is an attempt to write something the schema must refuse.
 *
 * Isolation: posted movements can never be deleted, so tests cannot clean up
 * after themselves. Each test that writes movements first creates its own
 * (variant, location) chain, which makes the chain-scoped constraints —
 * one opening movement, one successor per predecessor — independent per test.
 */

const NOW = new Date('2026-08-03T12:00:00.000Z');

/** Postgres SQLSTATEs asserted below, named so failures read clearly. */
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

let db: TestDatabase;

interface Chain {
  variantId: string;
  locationId: string;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-${skuCounter.toString().padStart(8, '0')}`;
}

/** A fresh product, variant, and location: one isolated movement chain. */
async function newChain(): Promise<Chain> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1, 'Ledger fixture', $2, $2)`,
    [productId, NOW],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
     VALUES ($1, $2, $3, '[]', $4, $4)`,
    [variantId, productId, nextSku(), NOW],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, 'Ledger fixture location', false, true, $2, $2)`,
    [locationId, NOW],
  );

  return { variantId, locationId };
}

/** An idempotency row. Movements require one; several may share it. */
async function newOperation(): Promise<string> {
  const id = newId();
  await db.pool.query(
    `INSERT INTO operations (id, operation_type, request_hash, created_at)
     VALUES ($1, 'inventory.test', $2, $3)`,
    [id, 'a'.repeat(64), NOW],
  );
  return id;
}

interface MovementFields {
  id?: string;
  movementType?: string;
  quantityDelta?: number;
  quantityBefore?: number;
  /** Defaults to `quantityBefore + quantityDelta`; set explicitly to break it. */
  quantityAfter?: number;
  previousMovementId?: string | null;
  reversesMovementId?: string | null;
  /**
   * The original's own type, which 0012 requires beside the pointer.
   *
   * Defaults to `'RECEIPT'` whenever a `reversesMovementId` is given, because
   * that is what these fixtures reverse; a test that needs the pair to
   * disagree with reality, or to be half-stated, sets it explicitly — `null`
   * gives a pointer with no type.
   */
  reversesMovementType?: string | null;
  reasonCode?: string | null;
  note?: string | null;
  operationId?: string;
}

/** Inserts one movement into `chain`, filling in a consistent default row. */
async function postMovement(chain: Chain, fields: MovementFields = {}): Promise<string> {
  const id = fields.id ?? newId();
  const quantityDelta = fields.quantityDelta ?? 5;
  const quantityBefore = fields.quantityBefore ?? 0;
  const quantityAfter = fields.quantityAfter ?? quantityBefore + quantityDelta;
  const operationId = fields.operationId ?? (await newOperation());

  await db.pool.query(
    `INSERT INTO inventory_movements (
       id, variant_id, location_id, movement_type,
       quantity_delta, quantity_before, quantity_after,
       previous_movement_id, reverses_movement_id, reverses_movement_type, operation_id,
       reason_code, note, user_id, occurred_at, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
    [
      id,
      chain.variantId,
      chain.locationId,
      fields.movementType ?? 'RECEIPT',
      quantityDelta,
      quantityBefore,
      quantityAfter,
      fields.previousMovementId ?? null,
      fields.reversesMovementId ?? null,
      fields.reversesMovementType === undefined
        ? fields.reversesMovementId
          ? 'RECEIPT'
          : null
        : fields.reversesMovementType,
      operationId,
      fields.reasonCode ?? null,
      fields.note ?? null,
      newId(), // user_id — no foreign key until identity exists
      NOW,
    ],
  );

  return id;
}

/** Inserts a balance row, optionally for a chain other than the pointer's. */
async function postBalance(
  chain: Chain,
  quantityOnHand: number,
  lastMovementId: string | null,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO inventory_balances (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [chain.variantId, chain.locationId, quantityOnHand, lastMovementId, NOW],
  );
}

/** The quoted text literals inside a CHECK constraint's definition. */
async function checkConstraintLiterals(name: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  expect(rows).toHaveLength(1);
  return [...rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((match) => match[1]!);
}

beforeAll(async () => {
  db = await createTestDatabase(); // migrates to head, including 0005
});

afterAll(async () => {
  await db.drop();
});

describe('ledger schema', () => {
  it('creates the operations, movements, and balances tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('operations', 'inventory_movements', 'inventory_balances')
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'inventory_balances',
      'inventory_movements',
      'operations',
    ]);
  });

  it('seeds no balance rows', async () => {
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_balances`,
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('accepts a well-formed movement and reads it back unchanged', async () => {
    const chain = await newChain();
    const id = await postMovement(chain, { quantityDelta: 7, quantityBefore: 0, note: 'opening' });

    const { rows } = await db.pool.query<{
      movement_type: string;
      quantity_delta: number;
      quantity_before: number;
      quantity_after: number;
      previous_movement_id: string | null;
    }>(
      `SELECT movement_type, quantity_delta, quantity_before, quantity_after, previous_movement_id
         FROM inventory_movements WHERE id = $1`,
      [id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      movement_type: 'RECEIPT',
      quantity_delta: 7,
      quantity_before: 0,
      quantity_after: 7,
      previous_movement_id: null,
    });
  });

  it('accepts a second movement chained onto the first', async () => {
    const chain = await newChain();
    const first = await postMovement(chain, { quantityDelta: 4 });
    await expect(
      postMovement(chain, {
        movementType: 'ADJUSTMENT_OUT',
        quantityDelta: -1,
        quantityBefore: 4,
        reasonCode: 'DAMAGE',
        previousMovementId: first,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('movement vocabulary', () => {
  it('matches MOVEMENT_TYPES from @ekon/shared exactly', async () => {
    const inDatabase = await checkConstraintLiterals('inventory_movements_type_known');
    expect([...inDatabase].sort()).toEqual([...MOVEMENT_TYPES].sort());
  });

  it('requires a reason for exactly REASON_REQUIRED_MOVEMENT_TYPES', async () => {
    const inDatabase = await checkConstraintLiterals('inventory_movements_reason_required');
    expect([...inDatabase].sort()).toEqual([...REASON_REQUIRED_MOVEMENT_TYPES].sort());
  });

  it('rejects a movement type outside the vocabulary', async () => {
    const chain = await newChain();
    await expect(postMovement(chain, { movementType: 'TRANSFER' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_type_known',
    });
  });
});

describe('movement quantity rules', () => {
  it('rejects a zero delta', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { quantityDelta: 0, quantityBefore: 3, quantityAfter: 3 }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_delta_not_zero',
    });
  });

  it('rejects a negative quantity_before', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { quantityBefore: -1, quantityDelta: 1, quantityAfter: 0 }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_before_non_negative',
    });
  });

  it('rejects a negative quantity_after', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, {
        movementType: 'ADJUSTMENT_OUT',
        reasonCode: 'DAMAGE',
        quantityBefore: 0,
        quantityDelta: -3,
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_after_non_negative',
    });
  });

  it('rejects before/delta/after arithmetic that does not add up', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { quantityBefore: 0, quantityDelta: 5, quantityAfter: 99 }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_arithmetic',
    });
  });
});

describe('reason codes and notes', () => {
  it('rejects an adjustment with no reason code', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { movementType: 'ADJUSTMENT_IN', reasonCode: null }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reason_required',
    });
  });

  it('rejects an issue with no reason code', async () => {
    // An issue says stock left; the reason says whether that was trade or
    // loss, and 0008 put it under the same constraint as an adjustment.
    const chain = await newChain();
    const opening = await postMovement(chain, { quantityDelta: 5 });
    await expect(
      postMovement(chain, {
        movementType: 'ISSUE',
        quantityDelta: -1,
        quantityBefore: 5,
        quantityAfter: 4,
        previousMovementId: opening,
        reasonCode: null,
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reason_required',
    });
  });

  it('accepts an adjustment that carries a reason code', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { movementType: 'ADJUSTMENT_IN', reasonCode: 'FOUND_STOCK' }),
    ).resolves.toBeTruthy();
  });

  it('does not require a reason code for a receipt', async () => {
    const chain = await newChain();
    await expect(postMovement(chain, { movementType: 'RECEIPT' })).resolves.toBeTruthy();
  });

  it('rejects a blank reason code', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { movementType: 'ADJUSTMENT_IN', reasonCode: '' }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reason_not_blank',
    });
  });

  it('rejects a whitespace-padded reason code', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { movementType: 'ADJUSTMENT_IN', reasonCode: '  DAMAGE  ' }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reason_trimmed',
    });
  });

  it('rejects an over-long reason code', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { movementType: 'ADJUSTMENT_IN', reasonCode: 'X'.repeat(61) }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reason_max_len',
    });
  });

  it('rejects an over-long note', async () => {
    const chain = await newChain();
    await expect(postMovement(chain, { note: 'x'.repeat(501) })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_note_max_len',
    });
  });
});

describe('reversal shape', () => {
  it('rejects a REVERSAL that names no original movement', async () => {
    const chain = await newChain();
    await postMovement(chain, { quantityDelta: 5 });
    await expect(
      postMovement(chain, {
        movementType: 'REVERSAL',
        quantityBefore: 5,
        quantityDelta: -5,
        reversesMovementId: null,
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reversal_names_original',
    });
  });

  it('rejects a non-reversal movement that claims to reverse something', async () => {
    const chain = await newChain();
    const original = await postMovement(chain, { quantityDelta: 5 });
    await expect(
      postMovement(chain, {
        movementType: 'ADJUSTMENT_OUT',
        reasonCode: 'DAMAGE',
        quantityBefore: 5,
        quantityDelta: -5,
        previousMovementId: original,
        reversesMovementId: original,
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_non_reversal_reverses_nothing',
    });
  });

  it('rejects a movement that reverses itself', async () => {
    const chain = await newChain();
    const id = newId();
    await expect(
      postMovement(chain, {
        id,
        movementType: 'REVERSAL',
        quantityDelta: 5,
        reversesMovementId: id,
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reverses_not_self',
    });
  });

  it('accepts a REVERSAL of an earlier movement in the same chain', async () => {
    const chain = await newChain();
    const original = await postMovement(chain, { quantityDelta: 5 });
    await expect(
      postMovement(chain, {
        movementType: 'REVERSAL',
        quantityBefore: 5,
        quantityDelta: -5,
        previousMovementId: original,
        reversesMovementId: original,
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects reversing the same original movement twice', async () => {
    const chain = await newChain();
    const original = await postMovement(chain, { quantityDelta: 5 });
    const second = await postMovement(chain, {
      quantityBefore: 5,
      quantityDelta: 5,
      previousMovementId: original,
    });
    const reversal = await postMovement(chain, {
      movementType: 'REVERSAL',
      quantityBefore: 10,
      quantityDelta: -5,
      previousMovementId: second,
      reversesMovementId: original,
    });

    await expect(
      postMovement(chain, {
        movementType: 'REVERSAL',
        quantityBefore: 5,
        quantityDelta: -5,
        previousMovementId: reversal,
        reversesMovementId: original,
      }),
    ).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'inventory_movements_reverses_once',
    });
  });
});

describe('reversal integrity added by 0012', () => {
  it('rejects a reversal of a reversal', async () => {
    // The rule the schema previously left to the posting workflow. Two
    // compensating movements chasing each other is not a correction of a
    // correction: it is a way to move stock indefinitely while every row claims
    // to be undoing something.
    const chain = await newChain();
    const original = await postMovement(chain, { quantityDelta: 5 });
    const reversal = await postMovement(chain, {
      movementType: 'REVERSAL',
      quantityBefore: 5,
      quantityDelta: -5,
      previousMovementId: original,
      reversesMovementId: original,
      reversesMovementType: 'RECEIPT',
    });

    await expect(
      postMovement(chain, {
        movementType: 'REVERSAL',
        quantityBefore: 0,
        quantityDelta: 5,
        previousMovementId: reversal,
        reversesMovementId: reversal,
        reversesMovementType: 'REVERSAL',
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reverses_not_a_reversal',
    });
  });

  it('rejects a reversal that misreports the original movement’s type', async () => {
    // The denormalized type exists to be constrained, not to be trusted: a
    // composite foreign key checks it against the original row's real type, so
    // the CHECK above cannot be satisfied by simply writing something else.
    const chain = await newChain();
    const original = await postMovement(chain, { quantityDelta: 5 });

    await expect(
      postMovement(chain, {
        movementType: 'REVERSAL',
        quantityBefore: 5,
        quantityDelta: -5,
        previousMovementId: original,
        reversesMovementId: original,
        reversesMovementType: 'ADJUSTMENT_IN',
      }),
    ).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'inventory_movements_reverses_type_fk',
    });
  });

  it('rejects a reversal that names an original without naming its type', async () => {
    // Half a pair would let the foreign key be skipped entirely: MATCH SIMPLE
    // does not check a key with a NULL column in it.
    const chain = await newChain();
    const original = await postMovement(chain, { quantityDelta: 5 });

    await expect(
      postMovement(chain, {
        movementType: 'REVERSAL',
        quantityBefore: 5,
        quantityDelta: -5,
        previousMovementId: original,
        reversesMovementId: original,
        reversesMovementType: null,
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reverses_pointer_complete',
    });
  });

  it('rejects a reversal of a movement on another chain', async () => {
    // The other rule 0012 took over from the workflow. A reversal that landed
    // on a different shelf would move stock that was never wrong, and leave the
    // stock that was.
    const first = await newChain();
    const second = await newChain();
    const original = await postMovement(first, { quantityDelta: 5 });

    await expect(
      postMovement(second, {
        movementType: 'REVERSAL',
        quantityBefore: 5,
        quantityDelta: -5,
        reversesMovementId: original,
        reversesMovementType: 'RECEIPT',
      }),
    ).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'inventory_movements_reverses_same_chain_fk',
    });
  });
});

describe('movement chain integrity', () => {
  it('rejects a second opening movement in the same chain', async () => {
    const chain = await newChain();
    await postMovement(chain, { quantityDelta: 5 });
    await expect(
      postMovement(chain, { quantityDelta: 5, previousMovementId: null }),
    ).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'inventory_movements_one_opening_idx',
    });
  });

  it('allows an opening movement in each of two different chains', async () => {
    const first = await newChain();
    const second = await newChain();
    await postMovement(first, { quantityDelta: 5 });
    await expect(postMovement(second, { quantityDelta: 5 })).resolves.toBeTruthy();
  });

  it('rejects two successors claiming the same predecessor', async () => {
    const chain = await newChain();
    const opening = await postMovement(chain, { quantityDelta: 5 });
    await postMovement(chain, {
      quantityBefore: 5,
      quantityDelta: 1,
      previousMovementId: opening,
    });

    await expect(
      postMovement(chain, {
        quantityBefore: 5,
        quantityDelta: 2,
        previousMovementId: opening,
      }),
    ).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'inventory_movements_one_successor',
    });
  });

  it('rejects a predecessor belonging to another chain', async () => {
    const first = await newChain();
    const second = await newChain();
    const foreignMovement = await postMovement(first, { quantityDelta: 5 });

    await expect(
      postMovement(second, {
        quantityBefore: 5,
        quantityDelta: 1,
        previousMovementId: foreignMovement,
      }),
    ).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'inventory_movements_previous_same_chain_fk',
    });
  });

  it('rejects a movement naming itself as its predecessor', async () => {
    const chain = await newChain();
    const id = newId();
    await expect(postMovement(chain, { id, previousMovementId: id })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_previous_not_self',
    });
  });

  it('rejects a predecessor that does not exist', async () => {
    const chain = await newChain();
    await expect(
      postMovement(chain, { quantityBefore: 1, previousMovementId: newId() }),
    ).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'inventory_movements_previous_same_chain_fk',
    });
  });
});

describe('balance constraints', () => {
  it('accepts a balance pointing at the last movement of its own chain', async () => {
    const chain = await newChain();
    const movement = await postMovement(chain, { quantityDelta: 5 });
    await expect(postBalance(chain, 5, movement)).resolves.toBeUndefined();
  });

  it('accepts a zero balance with no last movement', async () => {
    const chain = await newChain();
    await expect(postBalance(chain, 0, null)).resolves.toBeUndefined();
  });

  it('rejects a negative quantity_on_hand', async () => {
    const chain = await newChain();
    const movement = await postMovement(chain, { quantityDelta: 5 });
    await expect(postBalance(chain, -1, movement)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_balances_quantity_non_negative',
    });
  });

  it('rejects a nonzero balance with no last movement', async () => {
    const chain = await newChain();
    await expect(postBalance(chain, 5, null)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_balances_nonzero_has_movement',
    });
  });

  it('rejects a balance pointing at a movement from another chain', async () => {
    const first = await newChain();
    const second = await newChain();
    const foreignMovement = await postMovement(first, { quantityDelta: 5 });

    await expect(postBalance(second, 5, foreignMovement)).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'inventory_balances_last_movement_same_chain_fk',
    });
  });

  it('rejects a balance pointing at a movement that does not exist', async () => {
    const chain = await newChain();
    await expect(postBalance(chain, 5, newId())).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'inventory_balances_last_movement_same_chain_fk',
    });
  });
});

describe('deletion of referenced rows', () => {
  it('restricts deleting a variant that has movements', async () => {
    const chain = await newChain();
    await postMovement(chain, { quantityDelta: 5 });
    await expect(
      db.pool.query(`DELETE FROM product_variants WHERE id = $1`, [chain.variantId]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });

  it('restricts deleting a location that has movements', async () => {
    const chain = await newChain();
    await postMovement(chain, { quantityDelta: 5 });
    await expect(
      db.pool.query(`DELETE FROM inventory_locations WHERE id = $1`, [chain.locationId]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });

  it('restricts deleting a variant or location that only has a balance row', async () => {
    const chain = await newChain();
    await postBalance(chain, 0, null);
    await expect(
      db.pool.query(`DELETE FROM product_variants WHERE id = $1`, [chain.variantId]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    await expect(
      db.pool.query(`DELETE FROM inventory_locations WHERE id = $1`, [chain.locationId]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });

  it('restricts deleting the operation a movement was posted under', async () => {
    const chain = await newChain();
    const operationId = await newOperation();
    await postMovement(chain, { quantityDelta: 5, operationId });
    await expect(
      db.pool.query(`DELETE FROM operations WHERE id = $1`, [operationId]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });
});

describe('append-only protection', () => {
  it('rejects any UPDATE of a posted movement', async () => {
    const chain = await newChain();
    const id = await postMovement(chain, { quantityDelta: 5 });
    await expect(
      db.pool.query(`UPDATE inventory_movements SET note = 'edited' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('explains that corrections are compensating movements', async () => {
    const chain = await newChain();
    const id = await postMovement(chain, { quantityDelta: 5 });
    await expect(
      db.pool.query(`UPDATE inventory_movements SET quantity_delta = 99 WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable.*compensating movement/s);
  });

  it('rejects any DELETE of a posted movement', async () => {
    const chain = await newChain();
    const id = await postMovement(chain, { quantityDelta: 5 });
    await expect(
      db.pool.query(`DELETE FROM inventory_movements WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('rejects TRUNCATE, which bypasses row-level triggers', async () => {
    await expect(db.pool.query(`TRUNCATE inventory_movements CASCADE`)).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
  });

  it('still allows INSERT after an UPDATE and a DELETE have been refused', async () => {
    const chain = await newChain();
    const opening = await postMovement(chain, { quantityDelta: 5 });

    await expect(
      db.pool.query(`UPDATE inventory_movements SET note = 'edited' WHERE id = $1`, [opening]),
    ).rejects.toThrow();
    await expect(
      db.pool.query(`DELETE FROM inventory_movements WHERE id = $1`, [opening]),
    ).rejects.toThrow();

    await expect(
      postMovement(chain, {
        movementType: 'COUNT_RECONCILIATION',
        quantityBefore: 5,
        quantityDelta: -2,
        previousMovementId: opening,
        reasonCode: 'SHRINKAGE',
      }),
    ).resolves.toBeTruthy();

    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements WHERE variant_id = $1`,
      [chain.variantId],
    );
    expect(rows[0]!.count).toBe('2');
  });
});

describe('operations idempotency table', () => {
  it('rejects a duplicate operation id', async () => {
    const id = await newOperation();
    await expect(
      db.pool.query(
        `INSERT INTO operations (id, operation_type, request_hash, created_at)
         VALUES ($1, 'inventory.test', $2, $3)`,
        [id, 'b'.repeat(64), NOW],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'operations_pkey' });
  });

  it('rejects a blank or padded operation type', async () => {
    for (const operationType of ['', '  receive  ']) {
      await expect(
        db.pool.query(
          `INSERT INTO operations (id, operation_type, request_hash, created_at)
           VALUES ($1, $2, $3, $4)`,
          [newId(), operationType, 'c'.repeat(64), NOW],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });

  it('rejects a half-filled result pointer', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO operations (id, operation_type, request_hash, result_resource_type, created_at)
         VALUES ($1, 'inventory.test', $2, 'inventory_movement', $3)`,
        [newId(), 'd'.repeat(64), NOW],
      ),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'operations_result_pointer_complete',
    });
  });
});
