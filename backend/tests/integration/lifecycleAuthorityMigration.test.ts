import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, loadMigrations, migrateUp } from '../../src/platform/db/migrator.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0012 retires the `is_active` bridge and hands merchandise
 * availability to `lifecycle_status` alone. It runs over a catalog and a ledger
 * that are already carrying data, so the test that matters is the upgrade path:
 * migrate a fresh database to 0011, put representative 0011-era merchandise and
 * inventory history in it — including merchandise somebody had already
 * withdrawn with the old flag — apply 0012, and check that every identity the
 * ledger points at came through untouched and that the withdrawal survived.
 *
 * The one judgement call in the migration is what `is_active = false` becomes.
 * It cannot mean `ARCHIVED`: that status asserts the merchandise holds no
 * stock, which the old boolean never claimed and which the seeded rows here
 * deliberately contradict — one of them still has seven units on a shelf. So it
 * becomes `DISCONTINUED`, the conservative answer that preserves everything the
 * flag actually said (not replenished) and asserts nothing it could not know.
 * That choice is what the assertions below check, and it is checked against a
 * row that would have made the other choice a lie.
 */

const MIGRATIONS = defaultMigrationsDir();
const NOW = new Date('2026-08-23T12:00:00.000Z');
/** Deliberately older than the migration, so a rewritten `updated_at` is visible. */
const WITHDRAWN_AT = new Date('2026-06-01T09:30:00.000Z');
const LOCATION_ID = '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df78a'; // the default seeded by 0004

const tempDirs: string[] = [];

/** Stages every migration file up to and including `version` in a temp directory. */
async function stageThrough(version: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0012-'));
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

describe('migration 0012 — retiring the is_active bridge over live merchandise', () => {
  let db: TestDatabase;

  /** Everything seeded at 0011, recorded so the assertions compare against it. */
  const before = {
    activeProductId: newId(),
    withdrawnProductId: newId(),
    activeVariantId: newId(),
    /** A variant withdrawn on its own, under a product that is still active. */
    withdrawnVariantId: newId(),
    /** An active variant whose *product* was withdrawn. */
    orphanVariantId: newId(),
    operationId: newId(),
    movementId: newId(),
    userId: newId(),
    activeSku: 'EKN-ACTIVE01',
    withdrawnSku: 'EKN-GONE0001',
    orphanSku: 'EKN-ORPHAN01',
    quantity: 7,
  };

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stageThrough('0011'));

    // Merchandise as 0011 holds it: `is_active` is the authority, and
    // `lifecycle_status` is the inert column 0009 added.
    await db.pool.query(
      `INSERT INTO products (id, name, is_active, created_at, updated_at)
       VALUES ($1, 'Still Sold', true, $3, $3),
              ($2, 'Withdrawn Line', false, $3, $4)`,
      [before.activeProductId, before.withdrawnProductId, NOW, WITHDRAWN_AT],
    );

    await db.pool.query(
      `INSERT INTO product_variants
         (id, product_id, sku, variant_signature, is_active, created_at, updated_at)
       VALUES ($1, $4, $6, '[["color","black"]]', true,  $9, $9),
              ($2, $4, $7, '[["color","red"]]',   false, $9, $10),
              ($3, $5, $8, '[]',                  true,  $9, $9)`,
      [
        before.activeVariantId,
        before.withdrawnVariantId,
        before.orphanVariantId,
        before.activeProductId,
        before.withdrawnProductId,
        before.activeSku,
        before.withdrawnSku,
        before.orphanSku,
        NOW,
        WITHDRAWN_AT,
      ],
    );

    await db.pool.query(
      `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
       VALUES ($1, 'color', 'Black'), ($2, 'color', 'Red')`,
      [before.activeVariantId, before.withdrawnVariantId],
    );

    // Stock history against the variant that was withdrawn while it still held
    // units. This is the row that makes ARCHIVED the wrong backfill: archiving
    // asserts an empty shelf, and this shelf is not empty.
    await db.pool.query(
      `INSERT INTO operations (id, operation_type, request_hash, result_resource_type,
                               result_resource_id, created_at)
       VALUES ($1, 'inventory.receive', 'deadbeef', 'inventory_movement', $2, $3)`,
      [before.operationId, before.movementId, NOW],
    );
    await db.pool.query(
      `INSERT INTO inventory_movements (
         id, variant_id, location_id, movement_type,
         quantity_delta, quantity_before, quantity_after,
         previous_movement_id, reverses_movement_id, operation_id,
         reason_code, note, user_id, occurred_at, recorded_at)
       VALUES ($1, $2, $3, 'RECEIPT', $4, 0, $4, NULL, NULL, $5, NULL, NULL, $6, $7, $7)`,
      [
        before.movementId,
        before.withdrawnVariantId,
        LOCATION_ID,
        before.quantity,
        before.operationId,
        before.userId,
        NOW,
      ],
    );
    await db.pool.query(
      `INSERT INTO inventory_balances
         (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [before.withdrawnVariantId, LOCATION_ID, before.quantity, before.movementId, NOW],
    );

    // The upgrade under test.
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

  it('drops is_active from products and product_variants', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'is_active'
          AND table_name IN ('products', 'product_variants')`,
    );
    expect(rows).toEqual([]);
  });

  it('leaves is_active alone where it is a different fact', async () => {
    // Whether a person may sign in (INV-16) and whether a shelf is open (0004)
    // are not merchandise lifecycle. A migration that had gone looking for the
    // column name rather than for the concept would have taken both.
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'is_active'
        ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(['inventory_locations', 'users']);
  });

  it('migrates a withdrawn product to DISCONTINUED, not ARCHIVED', async () => {
    const { rows } = await db.pool.query<{ id: string; lifecycle_status: string }>(
      `SELECT id, lifecycle_status FROM products ORDER BY name`,
    );
    expect(rows).toEqual([
      { id: before.activeProductId, lifecycle_status: 'ACTIVE' },
      { id: before.withdrawnProductId, lifecycle_status: 'DISCONTINUED' },
    ]);
  });

  it('migrates a withdrawn variant to DISCONTINUED and leaves active ones alone', async () => {
    const { rows } = await db.pool.query<{ sku: string; lifecycle_status: string }>(
      `SELECT sku, lifecycle_status FROM product_variants ORDER BY sku`,
    );
    expect(rows).toEqual([
      { sku: before.activeSku, lifecycle_status: 'ACTIVE' },
      { sku: before.withdrawnSku, lifecycle_status: 'DISCONTINUED' },
      { sku: before.orphanSku, lifecycle_status: 'ACTIVE' },
    ]);
  });

  it('does not reactivate anything', async () => {
    // The failure mode worth naming: a migration that took `lifecycle_status`
    // at face value would have left every withdrawn row ACTIVE, quietly putting
    // merchandise the shop had retired back on the shelf.
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM products WHERE id = $1 AND lifecycle_status = 'ACTIVE'`,
      [before.withdrawnProductId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('keeps the stock of withdrawn merchandise visible rather than hidden behind an archive', async () => {
    // The reason DISCONTINUED is the conservative choice: this variant was
    // withdrawn with seven units still on a shelf. Under ARCHIVED they would be
    // invisible to every operational screen while remaining physically real —
    // and the archive invariant would have been broken by the migration that
    // introduced it.
    const { rows } = await db.pool.query<{ quantity_on_hand: number; lifecycle_status: string }>(
      `SELECT b.quantity_on_hand, v.lifecycle_status
         FROM inventory_balances b
         JOIN product_variants v ON v.id = b.variant_id
        WHERE b.variant_id = $1`,
      [before.withdrawnVariantId],
    );
    expect(rows[0]).toEqual({
      quantity_on_hand: before.quantity,
      lifecycle_status: 'DISCONTINUED',
    });
  });

  it('does not restamp updated_at on the rows it reconciles', async () => {
    // The lifecycle of this merchandise did not change today — what changed is
    // which column records it. Stamping the deploy date would erase when the
    // shop actually withdrew it.
    const { rows: products } = await db.pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM products WHERE id = $1`,
      [before.withdrawnProductId],
    );
    expect(products[0]?.updated_at.toISOString()).toBe(WITHDRAWN_AT.toISOString());

    const { rows: variants } = await db.pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM product_variants WHERE id = $1`,
      [before.withdrawnVariantId],
    );
    expect(variants[0]?.updated_at.toISOString()).toBe(WITHDRAWN_AT.toISOString());
  });

  it('changes no product id, variant id, or SKU', async () => {
    const { rows } = await db.pool.query<{ id: string; product_id: string; sku: string }>(
      `SELECT id, product_id, sku FROM product_variants ORDER BY sku`,
    );
    expect(rows).toEqual([
      {
        id: before.activeVariantId,
        product_id: before.activeProductId,
        sku: before.activeSku,
      },
      {
        id: before.withdrawnVariantId,
        product_id: before.activeProductId,
        sku: before.withdrawnSku,
      },
      {
        id: before.orphanVariantId,
        product_id: before.withdrawnProductId,
        sku: before.orphanSku,
      },
    ]);
  });

  it('changes no movement', async () => {
    // The whole point. 0012 adds a column and four constraints to
    // `inventory_movements`; it rewrites nothing, and the append-only triggers
    // would refuse if it tried.
    const { rows } = await db.pool.query<Record<string, unknown>>(
      `SELECT id, variant_id, location_id, movement_type, quantity_delta,
              quantity_before, quantity_after, previous_movement_id,
              reverses_movement_id, reverses_movement_type, operation_id,
              reason_code, note, user_id
         FROM inventory_movements`,
    );
    expect(rows).toEqual([
      {
        id: before.movementId,
        variant_id: before.withdrawnVariantId,
        location_id: LOCATION_ID,
        movement_type: 'RECEIPT',
        quantity_delta: before.quantity,
        quantity_before: 0,
        quantity_after: before.quantity,
        previous_movement_id: null,
        reverses_movement_id: null,
        // The new column is NULL on every pre-existing row, and MATCH SIMPLE
        // means its foreign key is not consulted for one.
        reverses_movement_type: null,
        operation_id: before.operationId,
        reason_code: null,
        note: null,
        user_id: before.userId,
      },
    ]);
  });

  it('changes no balance and no operation', async () => {
    const { rows: balances } = await db.pool.query(
      `SELECT variant_id, location_id, quantity_on_hand, last_movement_id
         FROM inventory_balances`,
    );
    expect(balances).toEqual([
      {
        variant_id: before.withdrawnVariantId,
        location_id: LOCATION_ID,
        quantity_on_hand: before.quantity,
        last_movement_id: before.movementId,
      },
    ]);

    const { rows: operations } = await db.pool.query(
      `SELECT id, operation_type, request_hash, result_resource_type, result_resource_id
         FROM operations`,
    );
    expect(operations).toEqual([
      {
        id: before.operationId,
        operation_type: 'inventory.receive',
        request_hash: 'deadbeef',
        result_resource_type: 'inventory_movement',
        result_resource_id: before.movementId,
      },
    ]);
  });

  it('keeps variant attributes exactly as they were', async () => {
    const { rows } = await db.pool.query(
      `SELECT variant_id, attribute_name, attribute_value
         FROM variant_attributes ORDER BY variant_id, attribute_name`,
    );
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      variant_id: before.activeVariantId,
      attribute_name: 'color',
      attribute_value: 'Black',
    });
  });

  it('adds the reversal constraints, and they hold on the upgraded ledger', async () => {
    const { rows } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'inventory_movements'::regclass
          AND conname IN (
            'inventory_movements_reverses_same_chain_fk',
            'inventory_movements_reverses_type_fk',
            'inventory_movements_reverses_pointer_complete',
            'inventory_movements_reverses_not_a_reversal',
            'inventory_movements_type_key'
          )
        ORDER BY conname`,
    );
    expect(rows.map((row) => row.conname)).toEqual([
      'inventory_movements_reverses_not_a_reversal',
      'inventory_movements_reverses_pointer_complete',
      'inventory_movements_reverses_same_chain_fk',
      'inventory_movements_reverses_type_fk',
      'inventory_movements_type_key',
    ]);

    // Every one of them is validated rather than deferred: an unchecked ledger
    // for the length of a deploy is the thing 0012 exists to prevent.
    const { rows: unvalidated } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'inventory_movements'::regclass AND NOT convalidated`,
    );
    expect(unvalidated).toEqual([]);
  });
});

describe('migration 0012 — on a clean database', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase(); // migrates to head from nothing
  });

  afterAll(async () => {
    await db.drop();
  });

  it('leaves a schema with lifecycle and without the bridge', async () => {
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_variants'
          AND column_name IN ('is_active', 'lifecycle_status')`,
    );
    expect(rows.map((row) => row.column_name)).toEqual(['lifecycle_status']);
  });

  it('still defaults new merchandise to ACTIVE', async () => {
    // The DEFAULT stays: it is what makes an insert that does not name the
    // column legal, and 0012 had no reason to take it away.
    const { rows } = await db.pool.query<{ column_default: string | null }>(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'products'
          AND column_name = 'lifecycle_status'`,
    );
    expect(rows[0]?.column_default).toContain('ACTIVE');
  });
});
