import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNT_RECONCILIATION_REASONS, REASON_REQUIRED_MOVEMENT_TYPES } from '@ekon/shared';
import { defaultMigrationsDir, loadMigrations, migrateUp } from '../../src/platform/db/migrator.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0013 adds the count evidence table to a catalog, an identity, and a
 * ledger that are already carrying data. It adds nothing to the ledger and
 * rewrites nothing anywhere, so the test that matters is the upgrade path:
 * migrate a fresh database to 0012, put representative merchandise, a user, a
 * movement and a balance in it, apply 0013, and check that every identity the
 * ledger points at came through untouched.
 *
 * The one change 0013 makes outside its own table is a CHECK: a
 * `COUNT_RECONCILIATION` now requires a reason. That is safe on existing data
 * for a structural reason rather than an optimistic one — no route, service, or
 * workflow has ever posted one — and this suite seeds the movement types that
 * *can* exist to prove the migration applies over them.
 */

const MIGRATIONS = defaultMigrationsDir();
const NOW = new Date('2026-08-23T12:00:00.000Z');
const LOCATION_ID = '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df78a'; // the default seeded by 0004
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';

const tempDirs: string[] = [];

async function stageThrough(version: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0013-'));
  tempDirs.push(dir);
  const files = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith('.sql') && name.slice(0, 4) <= version)
    .sort();
  for (const file of files) await copyFile(path.join(MIGRATIONS, file), path.join(dir, file));
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('migration 0013 — adding count evidence over a live ledger', () => {
  let db: TestDatabase;

  const before = {
    productId: newId(),
    variantId: newId(),
    userId: newId(),
    receiptOperationId: newId(),
    receiptId: newId(),
    issueOperationId: newId(),
    issueId: newId(),
    sku: 'EKN-COUNT001',
    quantity: 9,
  };

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stageThrough('0012'));

    await db.pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, is_active,
                          created_at, updated_at)
       VALUES ($1, 'counter', 'Counter', 'argon2id$placeholder', 'MANAGER', true, $2, $2)`,
      [before.userId, NOW],
    );
    await db.pool.query(
      `INSERT INTO products (id, name, lifecycle_status, created_at, updated_at)
       VALUES ($1, 'Counted Merchandise', 'ACTIVE', $2, $2)`,
      [before.productId, NOW],
    );
    await db.pool.query(
      `INSERT INTO product_variants
         (id, product_id, sku, variant_signature, lifecycle_status, created_at, updated_at)
       VALUES ($1, $2, $3, '[]', 'ACTIVE', $4, $4)`,
      [before.variantId, before.productId, before.sku, NOW],
    );

    // A receipt and an issue: the two movement types a 0012-era database can
    // actually hold with and without a reason code.
    await db.pool.query(
      `INSERT INTO operations (id, operation_type, request_hash, result_resource_type,
                               result_resource_id, created_at)
       VALUES ($1, 'inventory.receive', 'aaaa', 'inventory_movement', $2, $5),
              ($3, 'inventory.remove',  'bbbb', 'inventory_movement', $4, $5)`,
      [before.receiptOperationId, before.receiptId, before.issueOperationId, before.issueId, NOW],
    );
    await db.pool.query(
      `INSERT INTO inventory_movements (
         id, variant_id, location_id, movement_type,
         quantity_delta, quantity_before, quantity_after,
         previous_movement_id, reverses_movement_id, operation_id,
         reason_code, note, user_id, occurred_at, recorded_at)
       VALUES ($1, $3, $4, 'RECEIPT', 10, 0, 10, NULL, NULL, $5, NULL, NULL, $7, $8, $8),
              ($2, $3, $4, 'ISSUE',   -1, 10, 9, $1,   NULL, $6, 'SOLD', NULL, $7, $8, $8)`,
      [
        before.receiptId,
        before.issueId,
        before.variantId,
        LOCATION_ID,
        before.receiptOperationId,
        before.issueOperationId,
        before.userId,
        NOW,
      ],
    );
    await db.pool.query(
      `INSERT INTO inventory_balances
         (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [before.variantId, LOCATION_ID, before.quantity, before.issueId, NOW],
    );

    await migrateUp(db.pool, MIGRATIONS);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies every migration exactly once, in order', async () => {
    const applied = await db.pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    const expected = (await loadMigrations(MIGRATIONS)).map((migration) => migration.version);
    expect(applied.rows.map((row) => row.version)).toEqual(expected);
  });

  it('changes no movement', async () => {
    const { rows } = await db.pool.query<Record<string, unknown>>(
      `SELECT id, variant_id, location_id, movement_type, quantity_delta,
              quantity_before, quantity_after, previous_movement_id,
              reverses_movement_id, reverses_movement_type, operation_id,
              reason_code, note, user_id
         FROM inventory_movements ORDER BY recorded_at, id`,
    );
    expect(rows).toEqual([
      {
        id: before.receiptId,
        variant_id: before.variantId,
        location_id: LOCATION_ID,
        movement_type: 'RECEIPT',
        quantity_delta: 10,
        quantity_before: 0,
        quantity_after: 10,
        previous_movement_id: null,
        reverses_movement_id: null,
        reverses_movement_type: null,
        operation_id: before.receiptOperationId,
        reason_code: null,
        note: null,
        user_id: before.userId,
      },
      {
        id: before.issueId,
        variant_id: before.variantId,
        location_id: LOCATION_ID,
        movement_type: 'ISSUE',
        quantity_delta: -1,
        quantity_before: 10,
        quantity_after: 9,
        previous_movement_id: before.receiptId,
        reverses_movement_id: null,
        reverses_movement_type: null,
        operation_id: before.issueOperationId,
        reason_code: 'SOLD',
        note: null,
        user_id: before.userId,
      },
    ]);
  });

  it('adds no column to the ledger', async () => {
    // The count relationship lives on the count, as one pointer. A second
    // column on `inventory_movements` would be a second authority for one fact,
    // and the ledger is the table that must never carry a fact it does not
    // need.
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'inventory_movements'
          AND column_name LIKE '%count%'`,
    );
    expect(rows).toEqual([]);
  });

  it('changes no balance, no operation, and no merchandise identity', async () => {
    const { rows: balances } = await db.pool.query(
      `SELECT variant_id, location_id, quantity_on_hand, last_movement_id FROM inventory_balances`,
    );
    expect(balances).toEqual([
      {
        variant_id: before.variantId,
        location_id: LOCATION_ID,
        quantity_on_hand: before.quantity,
        last_movement_id: before.issueId,
      },
    ]);

    const { rows: operations } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM operations`,
    );
    expect(operations[0]?.count).toBe('2');

    const { rows: variants } = await db.pool.query(
      `SELECT id, product_id, sku, lifecycle_status FROM product_variants`,
    );
    expect(variants).toEqual([
      {
        id: before.variantId,
        product_id: before.productId,
        sku: before.sku,
        lifecycle_status: 'ACTIVE',
      },
    ]);
  });

  it('requires a reason for exactly the current shared vocabulary', async () => {
    // The database and the wire format cannot drift: 0013 added
    // `COUNT_RECONCILIATION` to both.
    const { rows } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'inventory_movements_reason_required'`,
    );
    const inDatabase = [...rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((match) => match[1]!);
    expect([...inDatabase].sort()).toEqual([...REASON_REQUIRED_MOVEMENT_TYPES].sort());
    expect(inDatabase).toContain('COUNT_RECONCILIATION');
  });

  it('publishes exactly the reconciliation reasons the shared contract does', async () => {
    const { rows } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'inventory_count_lines_reason_known'`,
    );
    const inDatabase = [...rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((match) => match[1]!);
    expect([...inDatabase].sort()).toEqual([...COUNT_RECONCILIATION_REASONS].sort());
    // The omission that matters: accepting a discrepancy is not a place to
    // record that the count itself was wrong.
    expect(inDatabase).not.toContain('COUNTING_ERROR');
  });
});

describe('what the count table refuses', () => {
  let db: TestDatabase;
  const userId = newId();
  const variantId = newId();
  const productId = newId();
  const operationIds: string[] = [];

  /** A fresh operation row, since every count line needs its own. */
  async function newOperation(type = 'inventory.count.record'): Promise<string> {
    const id = newId();
    operationIds.push(id);
    await db.pool.query(
      `INSERT INTO operations (id, operation_type, request_hash, created_at)
       VALUES ($1, $2, $3, $4)`,
      [id, type, id, NOW],
    );
    return id;
  }

  async function insertCount(
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const row = {
      id: newId(),
      variant_id: variantId,
      location_id: LOCATION_ID,
      expected_quantity: 7,
      counted_quantity: 6,
      counted_by_user_id: userId,
      counted_at: NOW,
      recorded_at: NOW,
      operation_id: await newOperation(),
      ...overrides,
    };
    const columns = Object.keys(row);
    await db.pool.query(
      `INSERT INTO inventory_count_lines (${columns.join(', ')})
       VALUES (${columns.map((_column, index) => `$${index + 1}`).join(', ')})`,
      Object.values(row),
    );
    return row;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, is_active,
                          created_at, updated_at)
       VALUES ($1, 'counter', 'Counter', 'argon2id$placeholder', 'MANAGER', true, $2, $2)`,
      [userId, NOW],
    );
    await db.pool.query(
      `INSERT INTO products (id, name, lifecycle_status, created_at, updated_at)
       VALUES ($1, 'Constrained', 'ACTIVE', $2, $2)`,
      [productId, NOW],
    );
    await db.pool.query(
      `INSERT INTO product_variants
         (id, product_id, sku, variant_signature, lifecycle_status, created_at, updated_at)
       VALUES ($1, $2, 'EKN-CNSTRNT1', '[]', 'ACTIVE', $3, $3)`,
      [variantId, productId, NOW],
    );
  });

  afterAll(async () => {
    await db.drop();
  });

  it('derives the variance and the status rather than accepting them', async () => {
    const row = await insertCount({ expected_quantity: 7, counted_quantity: 6 });
    const { rows } = await db.pool.query<{ variance: number; status: string }>(
      `SELECT variance, status FROM inventory_count_lines WHERE id = $1`,
      [row.id],
    );
    expect(rows[0]).toEqual({ variance: -1, status: 'OPEN' });

    // Neither can be written, so neither can be wrong.
    await expect(
      db.pool.query(
        `INSERT INTO inventory_count_lines
           (id, variant_id, location_id, expected_quantity, counted_quantity, variance,
            counted_by_user_id, counted_at, recorded_at, operation_id)
         VALUES ($1, $2, $3, 7, 6, 99, $4, $5, $5, $6)`,
        [newId(), variantId, LOCATION_ID, userId, NOW, await newOperation()],
      ),
    ).rejects.toThrow(/non-DEFAULT value into column "variance"/i);
  });

  it('settles a zero variance as MATCHED', async () => {
    const row = await insertCount({ expected_quantity: 4, counted_quantity: 4 });
    const { rows } = await db.pool.query<{ status: string }>(
      `SELECT status FROM inventory_count_lines WHERE id = $1`,
      [row.id],
    );
    expect(rows[0]?.status).toBe('MATCHED');
  });

  it('refuses a negative expected or counted quantity', async () => {
    await expect(insertCount({ counted_quantity: -1 })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_count_lines_counted_non_negative',
    });
    await expect(insertCount({ expected_quantity: -1 })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_count_lines_expected_non_negative',
    });
  });

  it('refuses merchandise, a shelf, a person, or an operation that does not exist', async () => {
    for (const override of [
      { variant_id: newId() },
      { location_id: newId() },
      { counted_by_user_id: newId() },
      { operation_id: newId() },
    ]) {
      await expect(insertCount(override), Object.keys(override)[0]).rejects.toMatchObject({
        code: FOREIGN_KEY_VIOLATION,
      });
    }
  });

  it('refuses two counts claiming one operation', async () => {
    const operationId = await newOperation();
    await insertCount({ operation_id: operationId });
    await expect(insertCount({ operation_id: operationId })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });

  it('refuses half a reconciliation', async () => {
    // Four columns, all set or all absent. A decision with no reason, or a
    // reason with nobody behind it, is half a record of a stock change.
    await expect(
      insertCount({ reconciled_at: NOW, reconciliation_reason: 'SHRINKAGE' }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_count_lines_reconciliation_complete',
    });
  });

  it('refuses a reason outside the vocabulary', async () => {
    await expect(
      insertCount({
        reconciled_at: NOW,
        reconciliation_reason: 'COUNTING_ERROR',
        reconciled_by_user_id: userId,
        reconciliation_operation_id: await newOperation('inventory.count.reconcile'),
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('requires a note for OTHER', async () => {
    await expect(
      insertCount({
        reconciled_at: NOW,
        reconciliation_reason: 'OTHER',
        reconciled_by_user_id: userId,
        reconciliation_operation_id: await newOperation('inventory.count.reconcile'),
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_count_lines_other_requires_note',
    });
  });

  it('refuses a settled count with no movement behind it', async () => {
    // The atomicity invariant as a row rule: it is impossible to store
    // RECONCILED without the movement that carried it.
    await expect(
      insertCount({
        reconciled_at: NOW,
        reconciliation_reason: 'SHRINKAGE',
        reconciled_by_user_id: userId,
        reconciliation_operation_id: await newOperation('inventory.count.reconcile'),
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_count_lines_settled_has_movement',
    });
  });

  it('refuses a reconciled match', async () => {
    await expect(
      insertCount({
        expected_quantity: 4,
        counted_quantity: 4,
        reconciled_at: NOW,
        reconciliation_reason: 'SHRINKAGE',
        reconciled_by_user_id: userId,
        reconciliation_operation_id: await newOperation('inventory.count.reconcile'),
      }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_count_lines_match_is_settled',
    });
  });

  it('refuses to rewrite the observation, and to change a settled decision', async () => {
    const row = await insertCount({ expected_quantity: 5, counted_quantity: 5 });
    await expect(
      db.pool.query(`UPDATE inventory_count_lines SET counted_at = $2 WHERE id = $1`, [
        row.id,
        new Date('2026-08-24T00:00:00.000Z'),
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });
});
