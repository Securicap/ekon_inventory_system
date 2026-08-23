import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, loadMigrations, migrateUp } from '../../src/platform/db/migrator.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0009 adds the merchandise foundation to a catalog and a ledger that
 * are already carrying data. The whole point of it is that it changes none of
 * that data, so the test that matters is the upgrade path: migrate a fresh
 * database to 0008, put representative 0008-era merchandise and inventory
 * history in it, apply 0009, and check that every identity the ledger points at
 * came through untouched.
 *
 * A movement rewritten to make one of these assertions pass would defeat the
 * exercise entirely. Nothing here updates one, and 0009 contains no statement
 * that could.
 */

const MIGRATIONS = defaultMigrationsDir();
const NOW = new Date('2026-08-23T12:00:00.000Z');
const LOCATION_ID = '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df78a'; // the default seeded by 0004

const tempDirs: string[] = [];

/** Stages every migration file up to and including `version` in a temp directory. */
async function stageThrough(version: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0009-'));
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

describe('migration 0009 — upgrading a database that already holds merchandise and history', () => {
  let db: TestDatabase;

  /** Everything seeded at 0008, recorded so the assertions compare against it. */
  const before = {
    productId: newId(),
    stockedVariantId: newId(),
    plainVariantId: newId(),
    operationId: newId(),
    movementId: newId(),
    userId: newId(),
    stockedSku: 'EKN-BELAMI89',
    plainSku: 'EKN-PLAIN777',
    stockedSignature: '[["color","black"],["size","8"]]',
    plainSignature: '[]',
    quantity: 7,
  };

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stageThrough('0008'));

    // A product with two variants: one carrying attributes and stock, one a
    // plain default variant. Exactly what the deployed application creates.
    await db.pool.query(
      `INSERT INTO products (id, name, description, created_at, updated_at)
       VALUES ($1, 'Steve Madden Bel Ami', 'A sandal', $2, $2)`,
      [before.productId, NOW],
    );
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5), ($6, $2, $7, $8, $5, $5)`,
      [
        before.stockedVariantId,
        before.productId,
        before.stockedSku,
        before.stockedSignature,
        NOW,
        before.plainVariantId,
        before.plainSku,
        before.plainSignature,
      ],
    );
    await db.pool.query(
      `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
       VALUES ($1, 'color', 'Black'), ($1, 'size', '8')`,
      [before.stockedVariantId],
    );

    // Real inventory history against the stocked variant: an operation, the
    // opening movement of its chain, and the balance projecting it.
    await db.pool.query(
      `INSERT INTO operations (id, operation_type, request_hash, result_resource_type, result_resource_id, created_at)
       VALUES ($1, 'inventory.receive', 'seedhash', 'inventory_movement', $2, $3)`,
      [before.operationId, before.movementId, NOW],
    );
    await db.pool.query(
      `INSERT INTO inventory_movements
         (id, variant_id, location_id, movement_type, quantity_delta, quantity_before,
          quantity_after, previous_movement_id, operation_id, user_id, occurred_at, recorded_at)
       VALUES ($1, $2, $3, 'RECEIPT', $4, 0, $4, NULL, $5, $6, $7, $7)`,
      [
        before.movementId,
        before.stockedVariantId,
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
      [before.stockedVariantId, LOCATION_ID, before.quantity, before.movementId, NOW],
    );

    const applied = await migrateUp(db.pool, await stageThrough('0009'));
    expect(applied).toEqual(['0009']);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('leaves product identity and every product column that existed untouched', async () => {
    const { rows } = await db.pool.query<{
      id: string;
      name: string;
      description: string | null;
      is_active: boolean;
    }>(`SELECT id, name, description, is_active FROM products`);
    expect(rows).toEqual([
      {
        id: before.productId,
        name: 'Steve Madden Bel Ami',
        description: 'A sandal',
        is_active: true,
      },
    ]);
  });

  it('leaves variant ids, SKUs, and signatures exactly as they were', async () => {
    const { rows } = await db.pool.query<{
      id: string;
      sku: string;
      variant_signature: string;
      product_id: string;
      is_active: boolean;
    }>(
      `SELECT id, sku, variant_signature, product_id, is_active FROM product_variants ORDER BY sku`,
    );
    expect(rows).toEqual([
      {
        id: before.stockedVariantId,
        sku: before.stockedSku,
        variant_signature: before.stockedSignature,
        product_id: before.productId,
        is_active: true,
      },
      {
        id: before.plainVariantId,
        sku: before.plainSku,
        variant_signature: before.plainSignature,
        product_id: before.productId,
        is_active: true,
      },
    ]);
  });

  it('leaves every stored variant attribute untouched', async () => {
    const { rows } = await db.pool.query<{ attribute_name: string; attribute_value: string }>(
      `SELECT attribute_name, attribute_value FROM variant_attributes
        WHERE variant_id = $1 ORDER BY attribute_name`,
      [before.stockedVariantId],
    );
    expect(rows).toEqual([
      { attribute_name: 'color', attribute_value: 'Black' },
      { attribute_name: 'size', attribute_value: '8' },
    ]);
  });

  it('leaves the movement referencing the same variant, with the same quantities', async () => {
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
    }>(
      `SELECT id, variant_id, location_id, movement_type, quantity_delta, quantity_before,
              quantity_after, previous_movement_id, operation_id
         FROM inventory_movements`,
    );
    expect(rows).toEqual([
      {
        id: before.movementId,
        variant_id: before.stockedVariantId,
        location_id: LOCATION_ID,
        movement_type: 'RECEIPT',
        quantity_delta: before.quantity,
        quantity_before: 0,
        quantity_after: before.quantity,
        previous_movement_id: null,
        operation_id: before.operationId,
      },
    ]);
  });

  it('leaves the balance on the same variant, at the same quantity', async () => {
    const { rows } = await db.pool.query<{
      variant_id: string;
      location_id: string;
      quantity_on_hand: number;
      last_movement_id: string | null;
    }>(
      `SELECT variant_id, location_id, quantity_on_hand, last_movement_id FROM inventory_balances`,
    );
    expect(rows).toEqual([
      {
        variant_id: before.stockedVariantId,
        location_id: LOCATION_ID,
        quantity_on_hand: before.quantity,
        last_movement_id: before.movementId,
      },
    ]);
  });

  it('keeps the balance equal to the sum of the ledger (INV-6)', async () => {
    const { rows } = await db.pool.query<{ projected: number; ledger: number }>(
      `SELECT b.quantity_on_hand AS projected,
              (SELECT COALESCE(SUM(m.quantity_delta), 0)
                 FROM inventory_movements m
                WHERE m.variant_id = b.variant_id AND m.location_id = b.location_id) AS ledger
         FROM inventory_balances b`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.projected)).toBe(Number(rows[0]!.ledger));
  });

  it('keeps the SKU immutability trigger in force', async () => {
    await expect(
      db.pool.query(`UPDATE product_variants SET sku = 'EKN-CHANGED1' WHERE id = $1`, [
        before.stockedVariantId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('keeps the movement ledger append-only', async () => {
    await expect(
      db.pool.query(`UPDATE inventory_movements SET quantity_delta = 99 WHERE id = $1`, [
        before.movementId,
      ]),
    ).rejects.toThrow();
    await expect(
      db.pool.query(`DELETE FROM inventory_movements WHERE id = $1`, [before.movementId]),
    ).rejects.toThrow();
  });

  it('backfills every existing product and variant to ACTIVE, inferring nothing', async () => {
    const products = await db.pool.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM products`,
    );
    const variants = await db.pool.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM product_variants`,
    );
    expect(products.rows.map((r) => r.lifecycle_status)).toEqual(['ACTIVE']);
    expect(variants.rows.map((r) => r.lifecycle_status)).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('leaves brand, price, and cost unknown rather than guessing them', async () => {
    const { rows } = await db.pool.query<{
      brand_id: string | null;
      selling_price_minor: string | null;
      selling_price_currency: string | null;
      reference_cost_minor: string | null;
      reference_cost_currency: string | null;
    }>(
      `SELECT p.brand_id, v.selling_price_minor, v.selling_price_currency,
              v.reference_cost_minor, v.reference_cost_currency
         FROM product_variants v JOIN products p ON p.id = v.product_id`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.brand_id).toBeNull();
      expect(row.selling_price_minor).toBeNull();
      expect(row.selling_price_currency).toBeNull();
      expect(row.reference_cost_minor).toBeNull();
      expect(row.reference_cost_currency).toBeNull();
    }

    // No brand row was invented from "Steve Madden Bel Ami" either.
    const brands = await db.pool.query(`SELECT 1 FROM brands`);
    expect(brands.rowCount).toBe(0);
  });

  it('creates no barcode and no classification assignment for existing merchandise', async () => {
    expect((await db.pool.query(`SELECT 1 FROM variant_barcodes`)).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM product_classifications`)).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM classification_values`)).rowCount).toBe(0);
  });

  it('seeds the three classification dimensions ADR 11 names, and no values', async () => {
    const { rows } = await db.pool.query<{ key: string; name: string }>(
      `SELECT key, name FROM classification_dimensions ORDER BY key`,
    );
    expect(rows).toEqual([
      { key: 'audience', name: 'Audience' },
      { key: 'category', name: 'Category' },
      { key: 'type', name: 'Type' },
    ]);
  });

  it('leaves the attribute vocabulary empty for the application to populate', async () => {
    // The transition 0009 documents: definitions exist, nothing references them,
    // and the names already stored are still there and still unconstrained.
    expect((await db.pool.query(`SELECT 1 FROM variant_attribute_definitions`)).rowCount).toBe(0);

    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM information_schema.table_constraints
        WHERE table_name = 'variant_attributes' AND constraint_type = 'FOREIGN KEY'`,
    );
    // Only the pre-existing key onto product_variants; no key onto definitions.
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

describe('migration 0009 — a clean database', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies every migration in the checkout, 0009 included', async () => {
    const { rows } = await db.pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    const applied = rows.map((r) => r.version);
    expect(applied).toContain('0009');
    // Compared against the checkout rather than a written-out list, so a later
    // migration extends this assertion instead of breaking it.
    expect(applied).toEqual((await loadMigrations()).map((m) => m.version));
  });

  it('creates every merchandise table', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('brands','classification_dimensions','classification_values',
                             'product_classifications','variant_attribute_definitions',
                             'variant_barcodes')
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'brands',
      'classification_dimensions',
      'classification_values',
      'product_classifications',
      'variant_attribute_definitions',
      'variant_barcodes',
    ]);
  });
});
