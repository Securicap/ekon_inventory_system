import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultMigrationsDir,
  migrateUp,
  migrationStatus,
} from '../../src/platform/db/migrator.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0006 drops `inventory_movements.device_id`.
 *
 * Driven exactly as production will drive it: migrate a fresh database to 0005,
 * write a movement in the 0005 shape — the one that still carries a device id —
 * then apply 0006 on top and check what survived. A column drop is easy to get
 * right and easy to under-test; what matters is that the history written before
 * it is intact and every ledger rule still bites afterwards.
 */

const MIGRATIONS = defaultMigrationsDir();
const THROUGH_0005 = [
  '0001_extensions_and_conventions.sql',
  '0002_catalog.sql',
  '0003_variant_value_case_insensitivity.sql',
  '0004_inventory_locations.sql',
  '0005_inventory_ledger_core.sql',
];
const M0006 = '0006_remove_movement_device_id.sql';
const NOW = new Date('2026-08-03T12:00:00.000Z');

const tempDirs: string[] = [];

/** Stages the given migration files into a fresh temp directory. */
async function stage(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0006-'));
  tempDirs.push(dir);
  for (const file of files) await copyFile(path.join(MIGRATIONS, file), path.join(dir, file));
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('migration 0006 — dropping device identity', () => {
  let db: TestDatabase;
  let variantId: string;
  let locationId: string;
  let legacyMovementId: string;
  let appliedBefore: { version: string; checksum: string; applied_at: Date }[];

  async function columnExists(column: string): Promise<boolean> {
    const { rows } = await db.pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'inventory_movements'
          AND column_name = $1`,
      [column],
    );
    return rows.length === 1;
  }

  async function newOperation(): Promise<string> {
    const id = newId();
    await db.pool.query(
      `INSERT INTO operations (id, operation_type, request_hash, created_at)
       VALUES ($1, 'inventory.test', $2, $3)`,
      [id, 'a'.repeat(64), NOW],
    );
    return id;
  }

  /** Inserts a movement in the post-0006 shape, with no device id. */
  async function insertMovement(fields: {
    id?: string;
    movementType?: string;
    quantityDelta?: number;
    quantityBefore?: number;
    quantityAfter?: number;
    previousMovementId?: string | null;
  }): Promise<string> {
    const id = fields.id ?? newId();
    const delta = fields.quantityDelta ?? 5;
    const before = fields.quantityBefore ?? 0;
    await db.pool.query(
      `INSERT INTO inventory_movements (
         id, variant_id, location_id, movement_type,
         quantity_delta, quantity_before, quantity_after,
         previous_movement_id, reverses_movement_id, operation_id,
         reason_code, note, user_id, occurred_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NULL, NULL, $10, $11, $11)`,
      [
        id,
        variantId,
        locationId,
        fields.movementType ?? 'RECEIPT',
        delta,
        before,
        fields.quantityAfter ?? before + delta,
        fields.previousMovementId ?? null,
        await newOperation(),
        newId(),
        NOW,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stage(THROUGH_0005));

    const productId = newId();
    await db.pool.query(
      `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1, 'Drop fixture', $2, $2)`,
      [productId, NOW],
    );
    variantId = newId();
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, 'EKN-DROP0001', '[]', $3, $3)`,
      [variantId, productId, NOW],
    );
    locationId = newId();
    await db.pool.query(
      `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
       VALUES ($1, 'Drop fixture location', false, true, $2, $2)`,
      [locationId, NOW],
    );

    // A 0005-era movement: written while device_id still existed and was NOT NULL.
    legacyMovementId = newId();
    await db.pool.query(
      `INSERT INTO inventory_movements (
         id, variant_id, location_id, movement_type,
         quantity_delta, quantity_before, quantity_after,
         previous_movement_id, reverses_movement_id, operation_id,
         reason_code, note, user_id, device_id, occurred_at, recorded_at)
       VALUES ($1, $2, $3, 'RECEIPT', 5, 0, 5, NULL, NULL, $4, NULL, 'pre-0006', $5, $6, $7, $7)`,
      [legacyMovementId, variantId, locationId, await newOperation(), newId(), newId(), NOW],
    );
    await db.pool.query(
      `INSERT INTO inventory_balances
         (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
       VALUES ($1, $2, 5, $3, $4)`,
      [variantId, locationId, legacyMovementId, NOW],
    );

    const { rows } = await db.pool.query<{
      version: string;
      checksum: string;
      applied_at: Date;
    }>(`SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version`);
    appliedBefore = rows;
    expect(appliedBefore.map((r) => r.version)).toEqual(['0001', '0002', '0003', '0004', '0005']);
    expect(await columnExists('device_id')).toBe(true);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies on top of the existing migrations', async () => {
    const applied = await migrateUp(db.pool, await stage([...THROUGH_0005, M0006]));
    expect(applied).toEqual(['0006']);
  });

  it('removes device_id and adds no replacement column', async () => {
    expect(await columnExists('device_id')).toBe(false);
    // Nothing crept in to take its place.
    for (const column of ['terminal_id', 'session_id', 'ip_address', 'user_agent', 'client_id']) {
      expect(await columnExists(column), `${column} should not exist`).toBe(false);
    }

    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'inventory_movements'
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'id',
      'location_id',
      'movement_type',
      'note',
      'occurred_at',
      'operation_id',
      'previous_movement_id',
      'quantity_after',
      'quantity_before',
      'quantity_delta',
      'reason_code',
      'recorded_at',
      'reverses_movement_id',
      'user_id',
      'variant_id',
    ]);
  });

  it('keeps the movement written before the drop, untouched apart from the column', async () => {
    const { rows } = await db.pool.query<{
      id: string;
      quantity_delta: number;
      quantity_after: number;
      note: string | null;
    }>(`SELECT id, quantity_delta, quantity_after, note FROM inventory_movements WHERE id = $1`, [
      legacyMovementId,
    ]);
    expect(rows[0]).toMatchObject({
      id: legacyMovementId,
      quantity_delta: 5,
      quantity_after: 5,
      note: 'pre-0006',
    });
  });

  it('still accepts a valid movement, chained onto the one written before it', async () => {
    const id = await insertMovement({
      quantityBefore: 5,
      quantityDelta: 3,
      previousMovementId: legacyMovementId,
    });
    const { rows } = await db.pool.query<{ quantity_after: number; previous_movement_id: string }>(
      `SELECT quantity_after, previous_movement_id FROM inventory_movements WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ quantity_after: 8, previous_movement_id: legacyMovementId });
  });

  it('keeps every ledger constraint, index, and trigger declared by 0005', async () => {
    const { rows: constraints } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid IN ('inventory_movements'::regclass, 'inventory_balances'::regclass)
        ORDER BY conname`,
    );
    const names = constraints.map((r) => r.conname);
    for (const expected of [
      'inventory_movements_type_known',
      'inventory_movements_delta_not_zero',
      'inventory_movements_before_non_negative',
      'inventory_movements_after_non_negative',
      'inventory_movements_arithmetic',
      'inventory_movements_adjustment_requires_reason',
      'inventory_movements_reversal_names_original',
      'inventory_movements_non_reversal_reverses_nothing',
      'inventory_movements_reverses_once',
      'inventory_movements_previous_not_self',
      'inventory_movements_one_successor',
      'inventory_movements_chain_key',
      'inventory_movements_previous_same_chain_fk',
      'inventory_balances_quantity_non_negative',
      'inventory_balances_nonzero_has_movement',
      'inventory_balances_last_movement_same_chain_fk',
    ]) {
      expect(names, `${expected} missing after 0006`).toContain(expected);
    }

    const { rows: indexes } = await db.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'inventory_movements' AND indexname = 'inventory_movements_one_opening_idx'`,
    );
    expect(indexes).toHaveLength(1);

    const { rows: triggers } = await db.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'inventory_movements'::regclass AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(triggers.map((r) => r.tgname)).toEqual([
      'inventory_movements_no_delete',
      'inventory_movements_no_truncate',
      'inventory_movements_no_update',
    ]);
  });

  it('still enforces those constraints, not just declares them', async () => {
    // Arithmetic.
    await expect(
      insertMovement({ quantityBefore: 8, quantityDelta: 1, quantityAfter: 99 }),
    ).rejects.toMatchObject({ constraint: 'inventory_movements_arithmetic' });

    // Zero delta.
    await expect(
      insertMovement({ quantityBefore: 8, quantityDelta: 0, quantityAfter: 8 }),
    ).rejects.toMatchObject({ constraint: 'inventory_movements_delta_not_zero' });

    // A second opening movement on a chain that already has one.
    await expect(
      insertMovement({ quantityBefore: 0, quantityDelta: 1, previousMovementId: null }),
    ).rejects.toMatchObject({ constraint: 'inventory_movements_one_opening_idx' });

    // Append-only.
    await expect(
      db.pool.query(`UPDATE inventory_movements SET note = 'edited' WHERE id = $1`, [
        legacyMovementId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query(`DELETE FROM inventory_movements WHERE id = $1`, [legacyMovementId]),
    ).rejects.toThrow(/immutable/);
  });

  it('is a no-op when the migrator runs again', async () => {
    expect(await migrateUp(db.pool, await stage([...THROUGH_0005, M0006]))).toEqual([]);
  });

  it('leaves the previously applied migrations untouched', async () => {
    const { rows } = await db.pool.query<{ version: string; checksum: string; applied_at: Date }>(
      `SELECT version, checksum, applied_at FROM schema_migrations
        WHERE version <> '0006' ORDER BY version`,
    );
    expect(rows.map((r) => ({ version: r.version, checksum: r.checksum }))).toEqual(
      appliedBefore.map((r) => ({ version: r.version, checksum: r.checksum })),
    );
    // Not re-stamped, either — a re-applied migration would move this.
    expect(rows.map((r) => r.applied_at.toISOString())).toEqual(
      appliedBefore.map((r) => r.applied_at.toISOString()),
    );

    const status = await migrationStatus(db.pool, await stage([...THROUGH_0005, M0006]));
    expect(status.map((r) => r.version)).toEqual(['0001', '0002', '0003', '0004', '0005', '0006']);
    for (const row of status) {
      expect(row.applied, `${row.filename} not applied`).toBe(true);
      expect(row.checksumMatches, `${row.filename} checksum drifted`).toBe(true);
    }
  });
});

describe('migration 0006 on a clean database', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    // The other path production takes: a brand-new database migrated straight
    // to head, where device_id never exists at any point.
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('migrates to head with no device_id anywhere in the schema', async () => {
    const { rows } = await db.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'device_id'`,
    );
    expect(rows).toEqual([]);
  });

  it('reports 0006 as applied and unmodified', async () => {
    // Deliberately not "0006 is the last migration": later migrations land on
    // top of it, and this suite is about the column drop, not about which file
    // happens to be at the head today.
    const status = await migrationStatus(db.pool);
    expect(status.find((row) => row.version === '0006')).toMatchObject({
      filename: M0006,
      applied: true,
      checksumMatches: true,
    });
  });
});
