import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, migrateUp } from '../../src/platform/db/migrator.js';
import {
  buildVariantSignature,
  normalizeAttributes,
} from '../../src/modules/catalog/domain/variantSignature.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0003 recomputes historical variant signatures under the new
 * case-insensitive-value rule. These tests drive it exactly as production does:
 * migrate a fresh database to 0002, seed 0002-era rows, then apply 0003.
 */

const MIGRATIONS = defaultMigrationsDir();
const M0001 = '0001_extensions_and_conventions.sql';
const M0002 = '0002_catalog.sql';
const M0003 = '0003_variant_value_case_insensitivity.sql';
const NOW = new Date('2026-08-03T12:00:00.000Z');

const tempDirs: string[] = [];

/** Stages the given migration files into a fresh temp directory. */
async function stage(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0003-'));
  tempDirs.push(dir);
  for (const file of files) await copyFile(path.join(MIGRATIONS, file), path.join(dir, file));
  return dir;
}

/** The pre-0003 signature: display-case values, sorted by name. */
function displaySignature(attributes: Record<string, string>): string {
  const pairs = Object.entries(attributes)
    .map(([name, value]): [string, string] => [name, value.trim()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(pairs);
}

/** The post-0003 signature that application code now produces. */
function identitySignature(attributes: Record<string, string>): string {
  return buildVariantSignature(normalizeAttributes(attributes, 'v'));
}

let skuCounter = 0;
function nextSku(): string {
  // EKN- + 8 chars from the allowed alphabet; unique per call.
  const n = (skuCounter++).toString().padStart(8, 'A').slice(-8).toUpperCase();
  return `EKN-${n.replace(/[^0-9A-Z]/g, 'A')}`;
}

async function seedVariant(
  db: TestDatabase,
  productId: string,
  attributes: Record<string, string>,
): Promise<string> {
  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [variantId, productId, nextSku(), displaySignature(attributes), NOW],
  );
  for (const [name, value] of Object.entries(attributes)) {
    await db.pool.query(
      `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
       VALUES ($1, $2, $3)`,
      [variantId, name, value],
    );
  }
  return variantId;
}

async function seedProduct(db: TestDatabase): Promise<string> {
  const id = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, created_at, updated_at) VALUES ($1, 'P', $2, $2)`,
    [id, NOW],
  );
  return id;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('migration 0003 — recompute of existing signatures', () => {
  let db: TestDatabase;
  const seeded: Record<string, { variantId: string; attributes: Record<string, string> }> = {};

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    const to0002 = await stage([M0001, M0002]);
    await migrateUp(db.pool, to0002);

    // Representative 0002-era data, each variant in its own product.
    const cases: Record<string, Record<string, string>> = {
      simple: { color: 'White', size: '9' },
      default: {},
      punctuation: { note: 'Navy "Blue", 50%' },
      unicode: { color: 'CAFÉ' },
    };
    for (const [key, attributes] of Object.entries(cases)) {
      const productId = await seedProduct(db);
      const variantId = await seedVariant(db, productId, attributes);
      seeded[key] = { variantId, attributes };
    }

    const to0003 = await stage([M0001, M0002, M0003]);
    const applied = await migrateUp(db.pool, to0003);
    expect(applied).toContain('0003');
  });

  afterAll(async () => {
    await db.drop();
  });

  async function signatureOf(variantId: string): Promise<string> {
    const { rows } = await db.pool.query<{ variant_signature: string }>(
      `SELECT variant_signature FROM product_variants WHERE id = $1`,
      [variantId],
    );
    return rows[0]!.variant_signature;
  }

  it('recomputes a signature to its lower-cased identity form', async () => {
    const { variantId, attributes } = seeded.simple!;
    expect(await signatureOf(variantId)).toBe(identitySignature(attributes));
    expect(await signatureOf(variantId)).toBe('[["color","white"],["size","9"]]');
  });

  it('preserves the stored display value (attribute_value is untouched)', async () => {
    const { variantId } = seeded.simple!;
    const { rows } = await db.pool.query<{ attribute_name: string; attribute_value: string }>(
      `SELECT attribute_name, attribute_value FROM variant_attributes
        WHERE variant_id = $1 ORDER BY attribute_name`,
      [variantId],
    );
    expect(rows).toEqual([
      { attribute_name: 'color', attribute_value: 'White' },
      { attribute_name: 'size', attribute_value: '9' },
    ]);
  });

  it('keeps the default variant signature as []', async () => {
    expect(await signatureOf(seeded.default!.variantId)).toBe('[]');
  });

  it('matches the TypeScript canonical signature for quotes, punctuation, and spaces', async () => {
    const { variantId, attributes } = seeded.punctuation!;
    expect(await signatureOf(variantId)).toBe(identitySignature(attributes));
  });

  it('matches the TypeScript canonical signature for Unicode, preserving display case', async () => {
    const { variantId, attributes } = seeded.unicode!;
    expect(await signatureOf(variantId)).toBe(identitySignature(attributes));
    const { rows } = await db.pool.query<{ attribute_value: string }>(
      `SELECT attribute_value FROM variant_attributes WHERE variant_id = $1`,
      [variantId],
    );
    expect(rows[0]?.attribute_value).toBe('CAFÉ'); // display case preserved
  });

  it('leaves the (product_id, variant_signature) uniqueness constraint in place', async () => {
    const { rows } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'product_variants_signature_unique'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('migration 0003 — duplicate preflight', () => {
  let db: TestDatabase;
  let whiteId: string;
  let lowerWhiteId: string;

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stage([M0001, M0002]));

    // Two variants of ONE product that are distinct under 0002 (different-case
    // signatures) but collapse under 0003.
    const productId = await seedProduct(db);
    whiteId = await seedVariant(db, productId, { color: 'White' });
    lowerWhiteId = await seedVariant(db, productId, { color: 'white' });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('aborts transactionally, leaving no partial updates', async () => {
    const dir = await stage([M0001, M0002, M0003]);
    await expect(migrateUp(db.pool, dir)).rejects.toThrow(/collapse to the same signature/);

    // Nothing changed: both signatures remain their original display-case form.
    const { rows } = await db.pool.query<{ id: string; variant_signature: string }>(
      `SELECT id, variant_signature FROM product_variants WHERE id = ANY($1)`,
      [[whiteId, lowerWhiteId]],
    );
    expect(rows.map((r) => r.variant_signature).sort()).toEqual(
      ['[["color","White"]]', '[["color","white"]]'].sort(),
    );

    // And 0003 was not recorded as applied.
    const applied = await db.pool.query(`SELECT 1 FROM schema_migrations WHERE version = '0003'`);
    expect(applied.rowCount).toBe(0);
  });
});
