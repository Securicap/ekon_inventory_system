import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, loadMigrations, migrateUp } from '../../src/platform/db/migrator.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0011 adds one index and touches nothing else. The tests are
 * therefore about what it did *not* do as much as what it did: a ledger with
 * movements in it must come through with the same rows, the same quantities,
 * and the same balances, because an index is not supposed to be able to change
 * any of that and a migration that did would be a very quiet disaster.
 */

const MIGRATIONS = defaultMigrationsDir();
const NOW = new Date('2026-08-24T12:00:00.000Z');
const LOCATION_ID = '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df78a'; // the default seeded by 0004
const tempDirs: string[] = [];

async function stageThrough(version: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0011-'));
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

describe('migration 0011 — upgrading a ledger that already holds movements', () => {
  let db: TestDatabase;

  const before = {
    productId: newId(),
    variantId: newId(),
    operationId: newId(),
    movementId: newId(),
    userId: newId(),
    quantity: 7,
  };

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stageThrough('0010'));

    await db.pool.query(
      `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1, 'Diri', $2, $2)`,
      [before.productId, NOW],
    );
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, 'EKN-HISTORY1', '[]', $3, $3)`,
      [before.variantId, before.productId, NOW],
    );
    await db.pool.query(
      `INSERT INTO operations (id, operation_type, request_hash, created_at)
       VALUES ($1, 'inventory.receive', 'seedhash', $2)`,
      [before.operationId, NOW],
    );
    await db.pool.query(
      `INSERT INTO inventory_movements
         (id, variant_id, location_id, movement_type, quantity_delta, quantity_before,
          quantity_after, previous_movement_id, operation_id, user_id, occurred_at, recorded_at)
       VALUES ($1, $2, $3, 'RECEIPT', $4, 0, $4, NULL, $5, $6, $7, $7)`,
      [
        before.movementId,
        before.variantId,
        LOCATION_ID,
        before.quantity,
        before.operationId,
        before.userId,
        NOW,
      ],
    );
    await db.pool.query(
      `INSERT INTO inventory_balances (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [before.variantId, LOCATION_ID, before.quantity, before.movementId, NOW],
    );

    const applied = await migrateUp(db.pool, await stageThrough('0011'));
    expect(applied).toEqual(['0011']);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('leaves the movement byte for byte as it was', async () => {
    const { rows } = await db.pool.query<{
      id: string;
      variant_id: string;
      location_id: string;
      movement_type: string;
      quantity_delta: number;
      quantity_before: number;
      quantity_after: number;
      previous_movement_id: string | null;
      operation_id: string;
      user_id: string;
    }>(
      `SELECT id, variant_id, location_id, movement_type, quantity_delta, quantity_before,
              quantity_after, previous_movement_id, operation_id, user_id
         FROM inventory_movements`,
    );
    expect(rows).toEqual([
      {
        id: before.movementId,
        variant_id: before.variantId,
        location_id: LOCATION_ID,
        movement_type: 'RECEIPT',
        quantity_delta: before.quantity,
        quantity_before: 0,
        quantity_after: before.quantity,
        previous_movement_id: null,
        operation_id: before.operationId,
        user_id: before.userId,
      },
    ]);
  });

  it('leaves the balance and its pointer alone', async () => {
    const { rows } = await db.pool.query<{
      variant_id: string;
      quantity_on_hand: number;
      last_movement_id: string | null;
    }>(`SELECT variant_id, quantity_on_hand, last_movement_id FROM inventory_balances`);
    expect(rows).toEqual([
      {
        variant_id: before.variantId,
        quantity_on_hand: before.quantity,
        last_movement_id: before.movementId,
      },
    ]);
  });

  it('keeps the ledger append-only', async () => {
    await expect(
      db.pool.query(`UPDATE inventory_movements SET quantity_delta = 99 WHERE id = $1`, [
        before.movementId,
      ]),
    ).rejects.toThrow();
    await expect(
      db.pool.query(`DELETE FROM inventory_movements WHERE id = $1`, [before.movementId]),
    ).rejects.toThrow();
  });

  it('adds the index, and nothing else', async () => {
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'inventory_movements'
          AND indexname = 'inventory_movements_recorded_at_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('(recorded_at, id)');
    expect(rows[0]?.indexdef).not.toContain('UNIQUE');

    // Every constraint the ledger had, it still has.
    const { rows: constraints } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'inventory_movements'::regclass
        ORDER BY conname`,
    );
    for (const expected of [
      'inventory_movements_arithmetic',
      'inventory_movements_delta_not_zero',
      'inventory_movements_reason_required',
      'inventory_movements_type_known',
    ]) {
      expect(constraints.map((c) => c.conname)).toContain(expected);
    }
  });

  it('matches the order the history feed reads in, with no sort step', async () => {
    // The claim the index exists to support: it can answer `recorded_at DESC,
    // id DESC` by scanning, rather than by collecting rows and sorting them.
    //
    // `enable_seqscan = off` because this fixture holds one movement, and on
    // one row a sequential scan is genuinely the right plan — the planner
    // choosing it says nothing either way. What is being asserted is that the
    // index *can* serve the ordering, which is what stops a deep page costing a
    // full scan once the ledger is large. The measurement on a realistic ledger
    // is recorded in the migration itself.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM inventory_movements ORDER BY recorded_at DESC, id DESC LIMIT 50`,
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('inventory_movements_recorded_at_idx');
      expect(plan).toContain('Backward');
      expect(plan).not.toContain('Sort');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('migration 0011 — a clean database', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies every migration in the checkout, 0011 included', async () => {
    const { rows } = await db.pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    const applied = rows.map((r) => r.version);
    expect(applied).toContain('0011');
    expect(applied).toEqual((await loadMigrations()).map((m) => m.version));
  });

  it('creates no table, column, or constraint of its own', async () => {
    // 0011 is one `CREATE INDEX`. If it ever grows a table, this fails.
    const sql = (await loadMigrations()).find((m) => m.version === '0011')?.sql ?? '';
    const statements = sql.replace(/--.*$/gm, '');
    expect(statements).toMatch(/CREATE INDEX/);
    expect(statements).not.toMatch(/CREATE TABLE|ALTER TABLE|INSERT|UPDATE|DELETE|DROP/i);
  });
});
