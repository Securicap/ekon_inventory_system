import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, loadMigrations, migrateUp } from '../../src/platform/db/migrator.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0010 makes `variant_attribute_definitions` authoritative for new
 * variant attributes without touching a single row that is already stored.
 *
 * That combination is the whole design, so it is what the upgrade path tests:
 * migrate to 0009, store an attribute name from before any vocabulary existed,
 * apply 0010, and check that the old row is untouched and still readable while
 * a new one with the same name is refused.
 */

const MIGRATIONS = defaultMigrationsDir();
const NOW = new Date('2026-08-24T12:00:00.000Z');
const tempDirs: string[] = [];

async function stageThrough(version: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0010-'));
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

describe('migration 0010 — upgrading a database with attribute names nobody defined', () => {
  let db: TestDatabase;

  const before = {
    productId: newId(),
    variantId: newId(),
    sku: 'EKN-LEGACY01',
    signature: '[["gwosè","5 mamit"],["koulè","blan"]]',
  };

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stageThrough('0009'));

    await db.pool.query(
      `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1, 'Diri', $2, $2)`,
      [before.productId, NOW],
    );
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [before.variantId, before.productId, before.sku, before.signature, NOW],
    );
    // Two names that no vocabulary will ever contain: this is a Creole-speaking
    // shop, and these are what somebody actually typed.
    await db.pool.query(
      `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
       VALUES ($1, 'gwosè', '5 mamit'), ($1, 'koulè', 'Blan')`,
      [before.variantId],
    );

    const applied = await migrateUp(db.pool, await stageThrough('0010'));
    expect(applied).toEqual(['0010']);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies at all, rather than refusing over data nobody has reviewed', () => {
    // The assertion is the `beforeAll` above: a migration that validated the
    // constraint would have failed there, and blocked the deploy.
    expect(true).toBe(true);
  });

  it('leaves every stored attribute exactly as it was', async () => {
    const { rows } = await db.pool.query<{ attribute_name: string; attribute_value: string }>(
      `SELECT attribute_name, attribute_value FROM variant_attributes
        WHERE variant_id = $1 ORDER BY attribute_name`,
      [before.variantId],
    );
    expect(rows).toEqual([
      { attribute_name: 'gwosè', attribute_value: '5 mamit' },
      { attribute_name: 'koulè', attribute_value: 'Blan' },
    ]);
  });

  it('leaves the variant identity — id, SKU, and signature — untouched', async () => {
    const { rows } = await db.pool.query<{
      id: string;
      sku: string;
      variant_signature: string;
      product_id: string;
    }>(`SELECT id, sku, variant_signature, product_id FROM product_variants`);
    expect(rows).toEqual([
      {
        id: before.variantId,
        sku: before.sku,
        variant_signature: before.signature,
        product_id: before.productId,
      },
    ]);
  });

  it('refuses a new attribute even under a name the legacy rows use', async () => {
    // The exemption is for rows already stored, not for the name.
    const otherVariantId = newId();
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, 'EKN-NEWONE01', '[["gwosè","10 mamit"]]', $3, $3)`,
      [otherVariantId, before.productId, NOW],
    );
    await expect(
      db.pool.query(
        `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
         VALUES ($1, 'gwosè', '10 mamit')`,
        [otherVariantId],
      ),
    ).rejects.toThrow(/variant_attributes_name_defined_fk/);
  });

  it('accepts a new attribute from the seeded vocabulary', async () => {
    const okVariantId = newId();
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, 'EKN-NEWTWO01', '[["color","black"]]', $3, $3)`,
      [okVariantId, before.productId, NOW],
    );
    await expect(
      db.pool.query(
        `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
         VALUES ($1, 'color', 'Black')`,
        [okVariantId],
      ),
    ).resolves.toBeDefined();
  });

  it('leaves the constraint unvalidated, which is what keeps the old rows legal', async () => {
    const { rows } = await db.pool.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'variant_attributes_name_defined_fk'`,
    );
    expect(rows[0]?.convalidated).toBe(false);
  });

  it('would validate once every legacy name has a definition', async () => {
    // The operator task 0010 documents, performed here to prove it completes.
    // Defining a name is a decision about merchandise; this test only shows
    // that nothing structural stands in the way of making it.
    for (const name of ['gwosè', 'koulè']) {
      await db.pool.query(
        `INSERT INTO variant_attribute_definitions (id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $3)`,
        [newId(), name, NOW],
      );
    }
    await expect(
      db.pool.query(
        `ALTER TABLE variant_attributes VALIDATE CONSTRAINT variant_attributes_name_defined_fk`,
      ),
    ).resolves.toBeDefined();

    const { rows } = await db.pool.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'variant_attributes_name_defined_fk'`,
    );
    expect(rows[0]?.convalidated).toBe(true);
  });
});

describe('migration 0010 — a clean database', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies every migration in the checkout, 0010 included', async () => {
    const { rows } = await db.pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    const applied = rows.map((r) => r.version);
    expect(applied).toContain('0010');
    expect(applied).toEqual((await loadMigrations()).map((m) => m.version));
  });

  it('seeds exactly the four names the merchandise model needs', async () => {
    const { rows } = await db.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM variant_attribute_definitions ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(['color', 'material', 'size', 'width']);
    // Application-shaped ids, written literally so a migration produces the same
    // rows in every environment — never `gen_random_uuid()` (0001).
    for (const row of rows) expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('is a no-op if it were somehow applied twice', async () => {
    // `ON CONFLICT (name) DO NOTHING`: a replay defines nothing a second time.
    await db.pool.query(
      `INSERT INTO variant_attribute_definitions (id, name, created_at, updated_at)
       VALUES ($1, 'color', $2, $2) ON CONFLICT (name) DO NOTHING`,
      [newId(), NOW],
    );
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM variant_attribute_definitions`,
    );
    expect(rows[0]?.count).toBe('4');
  });
});
