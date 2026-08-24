import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  DEFAULT_ROLE_CAPABILITIES,
  MOVEMENT_TYPES,
  REASON_REQUIRED_MOVEMENT_TYPES,
  ROLES,
} from '@ekon/shared';
import {
  defaultMigrationsDir,
  loadMigrations,
  migrateUp,
  migrationStatus,
} from '../../src/platform/db/migrator.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0008 widens two closed vocabularies: `ISSUE` joins the movement
 * types, and `inventory.remove` joins the capabilities.
 *
 * Driven exactly as production will drive it: migrate a fresh database to 0007,
 * write the history a real installation would already hold, then apply 0008 on
 * top and check what survived. Both changes are CHECK-constraint replacements
 * on tables that carry permanent records, and a constraint swap is easy to get
 * right and easy to under-test — what matters is that everything written before
 * it is intact, that every rule the ledger already had still bites, and that
 * the new value is genuinely accepted rather than merely declared.
 *
 * One of the three constraint changes is *narrower* than what it replaces:
 * `ISSUE` requires a reason. That is safe here for a structural reason rather
 * than an optimistic one — `ISSUE` was not in the vocabulary until this same
 * migration added it, so no existing row can carry it. The adjustment types are
 * covered exactly as they were, and that is asserted too.
 */

const MIGRATIONS = defaultMigrationsDir();
const THROUGH_0007 = [
  '0001_extensions_and_conventions.sql',
  '0002_catalog.sql',
  '0003_variant_value_case_insensitivity.sql',
  '0004_inventory_locations.sql',
  '0005_inventory_ledger_core.sql',
  '0006_remove_movement_device_id.sql',
  '0007_identity.sql',
];
const M0008 = '0008_inventory_stock_removal.sql';
const NOW = new Date('2026-08-06T12:00:00.000Z');

const CHECK_VIOLATION = '23514';

const tempDirs: string[] = [];

/** Stages the given migration files into a fresh temp directory. */
async function stage(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ekon-0008-'));
  tempDirs.push(dir);
  for (const file of files) await copyFile(path.join(MIGRATIONS, file), path.join(dir, file));
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('migration 0008 — ordinary stock removal', () => {
  let db: TestDatabase;
  let variantId: string;
  let locationId: string;
  let receiptId: string;
  let adjustmentId: string;
  let appliedBefore: { version: string; checksum: string; applied_at: Date }[];
  let grantsBefore: { role: string; capability: string }[];

  /** The literal values a closed-vocabulary CHECK constraint names. */
  async function checkConstraintLiterals(name: string): Promise<string[]> {
    const { rows } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [name],
    );
    expect(rows, `constraint ${name} does not exist`).toHaveLength(1);
    return [...rows[0]!.def.matchAll(/'([A-Za-z_.]+)'::text/g)].map((match) => match[1]!);
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

  /** Inserts one movement directly, the way the ledger's own tests do. */
  async function insertMovement(fields: {
    movementType?: string;
    quantityDelta?: number;
    quantityBefore?: number;
    reasonCode?: string | null;
    previousMovementId?: string | null;
  }): Promise<string> {
    const id = newId();
    const delta = fields.quantityDelta ?? 5;
    const before = fields.quantityBefore ?? 0;
    await db.pool.query(
      `INSERT INTO inventory_movements (
         id, variant_id, location_id, movement_type,
         quantity_delta, quantity_before, quantity_after,
         previous_movement_id, reverses_movement_id, operation_id,
         reason_code, note, user_id, occurred_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, NULL, $11, $12, $12)`,
      [
        id,
        variantId,
        locationId,
        fields.movementType ?? 'RECEIPT',
        delta,
        before,
        before + delta,
        fields.previousMovementId ?? null,
        await newOperation(),
        fields.reasonCode ?? null,
        newId(),
        NOW,
      ],
    );
    return id;
  }

  async function grants(): Promise<{ role: string; capability: string }[]> {
    const { rows } = await db.pool.query<{ role: string; capability: string }>(
      `SELECT role, capability FROM role_capabilities ORDER BY role, capability`,
    );
    return rows;
  }

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    await migrateUp(db.pool, await stage(THROUGH_0007));

    const productId = newId();
    await db.pool.query(
      `INSERT INTO products (id, name, created_at, updated_at)
       VALUES ($1, 'Removal migration fixture', $2, $2)`,
      [productId, NOW],
    );
    variantId = newId();
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, 'EKN-MIG00008', '[]', $3, $3)`,
      [variantId, productId, NOW],
    );
    locationId = newId();
    await db.pool.query(
      `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
       VALUES ($1, 'Removal migration location', false, true, $2, $2)`,
      [locationId, NOW],
    );

    // The history a real installation already holds when 0008 arrives: one
    // receipt with no reason, and one adjustment with one.
    receiptId = await insertMovement({ quantityDelta: 10 });
    adjustmentId = await insertMovement({
      movementType: 'ADJUSTMENT_OUT',
      quantityDelta: -2,
      quantityBefore: 10,
      reasonCode: 'DAMAGE',
      previousMovementId: receiptId,
    });
    await db.pool.query(
      `INSERT INTO inventory_balances
         (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
       VALUES ($1, $2, 8, $3, $4)`,
      [variantId, locationId, adjustmentId, NOW],
    );

    const { rows } = await db.pool.query<{
      version: string;
      checksum: string;
      applied_at: Date;
    }>(`SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version`);
    appliedBefore = rows;
    expect(appliedBefore.map((r) => r.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
    ]);

    grantsBefore = await grants();
    // Before 0008, an issue is not a movement type and removal is not a
    // capability. Both are asserted so the tests below cannot pass vacuously.
    await expect(insertMovement({ movementType: 'ISSUE' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_type_known',
    });
    await expect(
      db.pool.query(
        `INSERT INTO role_capabilities (role, capability) VALUES ('OWNER', 'inventory.remove')`,
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies on top of the existing migrations', async () => {
    const applied = await migrateUp(db.pool, await stage([...THROUGH_0007, M0008]));
    expect(applied).toEqual(['0008']);
  });

  it('keeps every movement written before it, exactly as it was', async () => {
    const { rows } = await db.pool.query<{
      id: string;
      movement_type: string;
      quantity_delta: number;
      quantity_after: number;
      reason_code: string | null;
    }>(
      `SELECT id, movement_type, quantity_delta, quantity_after, reason_code
         FROM inventory_movements ORDER BY recorded_at, id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === receiptId)).toMatchObject({
      movement_type: 'RECEIPT',
      quantity_delta: 10,
      quantity_after: 10,
      // A receipt still needs no reason. The narrower constraint did not reach
      // back and invalidate it.
      reason_code: null,
    });
    expect(rows.find((r) => r.id === adjustmentId)).toMatchObject({
      movement_type: 'ADJUSTMENT_OUT',
      quantity_delta: -2,
      quantity_after: 8,
      reason_code: 'DAMAGE',
    });

    const { rows: balances } = await db.pool.query<{ quantity_on_hand: number }>(
      `SELECT quantity_on_hand FROM inventory_balances
        WHERE variant_id = $1 AND location_id = $2`,
      [variantId, locationId],
    );
    expect(balances[0]?.quantity_on_hand).toBe(8);
  });

  it('names exactly the shared movement vocabulary, ISSUE included', async () => {
    const inDatabase = await checkConstraintLiterals('inventory_movements_type_known');
    expect([...inDatabase].sort()).toEqual([...MOVEMENT_TYPES].sort());
    expect(inDatabase).toContain('ISSUE');
  });

  it('accepts an ISSUE that says why', async () => {
    const id = await insertMovement({
      movementType: 'ISSUE',
      quantityDelta: -3,
      quantityBefore: 8,
      reasonCode: 'SOLD',
      previousMovementId: adjustmentId,
    });
    const { rows } = await db.pool.query<{ quantity_after: number; reason_code: string }>(
      `SELECT quantity_after, reason_code FROM inventory_movements WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ quantity_after: 5, reason_code: 'SOLD' });
  });

  it('refuses an ISSUE that does not', async () => {
    // The type says stock left; the reason says whether that was trade or loss.
    await expect(
      insertMovement({ movementType: 'ISSUE', quantityDelta: -1, quantityBefore: 8 }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'inventory_movements_reason_required',
    });
  });

  it('requires a reason for exactly the three types 0008 named', async () => {
    // As 0008 left it, and this suite is staged at 0008. The list has since
    // grown — 0013 adds `COUNT_RECONCILIATION`, because a reconciliation with
    // no reason records that somebody moved stock to match a count and would
    // not say why. That the *current* schema matches the current shared
    // vocabulary is asserted by 0013's suite, against a database at head.
    const inDatabase = await checkConstraintLiterals('inventory_movements_reason_required');
    expect([...inDatabase].sort()).toEqual(['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'ISSUE']);
    // Every type 0008 named is still reason-required today; nothing was dropped.
    for (const type of inDatabase) {
      expect(REASON_REQUIRED_MOVEMENT_TYPES).toContain(type);
    }
  });

  it('leaves the reason rule for every other movement type alone', async () => {
    // A receipt and a reversal each carry their reason somewhere other than
    // this column, and 0008 must not have made them say it twice.
    const receipt = await insertMovement({
      quantityDelta: 4,
      quantityBefore: 5,
      previousMovementId: (
        await db.pool.query<{ id: string }>(
          `SELECT id FROM inventory_movements WHERE movement_type = 'ISSUE' LIMIT 1`,
        )
      ).rows[0]!.id,
    });
    const { rows } = await db.pool.query<{ reason_code: string | null }>(
      `SELECT reason_code FROM inventory_movements WHERE id = $1`,
      [receipt],
    );
    expect(rows[0]?.reason_code).toBeNull();
  });

  it('still refuses a movement type outside the vocabulary', async () => {
    for (const invented of ['TRANSFER', 'SALE', 'issue', 'SHIPMENT']) {
      await expect(
        insertMovement({ movementType: invented, quantityDelta: -1, quantityBefore: 8 }),
        invented,
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'inventory_movements_type_known',
      });
    }
  });

  it('keeps every other ledger constraint, index, and trigger', async () => {
    const { rows: constraints } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid IN ('inventory_movements'::regclass, 'inventory_balances'::regclass)
        ORDER BY conname`,
    );
    const names = constraints.map((r) => r.conname);
    for (const expected of [
      'inventory_movements_type_known',
      'inventory_movements_reason_required',
      'inventory_movements_delta_not_zero',
      'inventory_movements_before_non_negative',
      'inventory_movements_after_non_negative',
      'inventory_movements_arithmetic',
      'inventory_movements_reason_trimmed',
      'inventory_movements_reason_not_blank',
      'inventory_movements_reason_max_len',
      'inventory_movements_note_max_len',
      'inventory_movements_reversal_names_original',
      'inventory_movements_non_reversal_reverses_nothing',
      'inventory_movements_reverses_not_self',
      'inventory_movements_reverses_once',
      'inventory_movements_previous_not_self',
      'inventory_movements_one_successor',
      'inventory_movements_chain_key',
      'inventory_movements_previous_same_chain_fk',
      'inventory_balances_quantity_non_negative',
      'inventory_balances_nonzero_has_movement',
      'inventory_balances_last_movement_same_chain_fk',
    ]) {
      expect(names, `${expected} is missing`).toContain(expected);
    }
    // The old name is gone: the constraint is no longer about adjustments.
    expect(names).not.toContain('inventory_movements_adjustment_requires_reason');

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

  it('still enforces those rules rather than merely declaring them', async () => {
    // The append-only ledger, after a migration that touched its constraints.
    await expect(
      db.pool.query(`UPDATE inventory_movements SET note = 'edited' WHERE id = $1`, [receiptId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.pool.query(`DELETE FROM inventory_movements WHERE id = $1`, [receiptId]),
    ).rejects.toThrow(/append-only/);

    // And the stock floor, which is what removal will lean on.
    await expect(
      insertMovement({
        movementType: 'ISSUE',
        quantityDelta: -99,
        quantityBefore: 5,
        reasonCode: 'SOLD',
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('names exactly the shared capability vocabulary, inventory.remove included', async () => {
    const inDatabase = await checkConstraintLiterals('role_capabilities_capability_known');
    expect([...inDatabase].sort()).toEqual([...CAPABILITIES].sort());
    expect(inDatabase).toContain('inventory.remove');
  });

  it('grants inventory.remove to all four roles and revokes nothing', async () => {
    const after = await grants();
    const added = after.filter(
      (row) => !grantsBefore.some((b) => b.role === row.role && b.capability === row.capability),
    );
    expect(added).toEqual([
      { role: 'EMPLOYEE', capability: 'inventory.remove' },
      { role: 'MANAGER', capability: 'inventory.remove' },
      { role: 'OWNER', capability: 'inventory.remove' },
      { role: 'SUPER_ADMIN', capability: 'inventory.remove' },
    ]);

    // Nothing that was granted before is gone.
    for (const before of grantsBefore) {
      expect(
        after.some((row) => row.role === before.role && row.capability === before.capability),
        `${before.role} lost ${before.capability}`,
      ).toBe(true);
    }
  });

  it('leaves the seed agreeing with DEFAULT_ROLE_CAPABILITIES exactly', async () => {
    // The seed is written out by hand across two migrations and the mapping is
    // written out by hand in `@ekon/shared`, because neither may import the
    // other. This is what keeps them from drifting.
    const mapping: Record<string, string[]> = {};
    for (const row of await grants()) (mapping[row.role] ??= []).push(row.capability);

    const expected: Record<string, string[]> = {};
    for (const role of ROLES) expected[role] = [...(DEFAULT_ROLE_CAPABILITIES[role] ?? [])].sort();

    expect(mapping).toEqual(expected);
  });

  it('gives an employee removal but not adjustment', async () => {
    // The whole point of a separate capability. Recording that stock left is
    // the counter job; correcting a balance that was wrong is not.
    const { rows } = await db.pool.query<{ capability: string }>(
      `SELECT capability FROM role_capabilities WHERE role = 'EMPLOYEE' ORDER BY capability`,
    );
    expect(rows.map((r) => r.capability)).toEqual([
      'catalog.read',
      'inventory.read',
      'inventory.receive',
      'inventory.remove',
    ]);
  });

  it('still refuses a capability outside the vocabulary', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO role_capabilities (role, capability) VALUES ('OWNER', 'inventory.destroy')`,
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('is a no-op when the migrator runs again', async () => {
    expect(await migrateUp(db.pool, await stage([...THROUGH_0007, M0008]))).toEqual([]);
  });

  it('leaves the previously applied migrations untouched', async () => {
    // Applied migrations are immutable. 0008 must not have rewritten a row in
    // `schema_migrations` or restamped anything that ran before it.
    const { rows } = await db.pool.query<{
      version: string;
      checksum: string;
      applied_at: Date;
    }>(`SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version`);

    expect(rows.map((r) => r.version)).toEqual([...appliedBefore.map((r) => r.version), '0008']);
    for (const before of appliedBefore) {
      const now = rows.find((r) => r.version === before.version);
      expect(now?.checksum).toBe(before.checksum);
      expect(now?.applied_at.toISOString()).toBe(before.applied_at.toISOString());
    }
  });
});

describe('migration 0008 on a clean database', () => {
  let db: TestDatabase;
  /** The newest migration in the checkout. Read, not pinned: this suite is about
   *  0008 arriving on an empty database, and a later migration must not make it
   *  fail. What 0008 itself produces is asserted below, by name. */
  let head: string;

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    head = (await loadMigrations()).at(-1)!.version;
  });

  afterAll(async () => {
    await db.drop();
  });

  it('migrates an empty database straight to head', async () => {
    const applied = await migrateUp(db.pool);
    expect(applied).toContain('0008');
    expect(applied.at(-1)).toBe(head);
  });

  it('reports every migration as applied and unmodified', async () => {
    const status = await migrationStatus(db.pool);
    expect(status.at(-1)?.version).toBe(head);
    for (const row of status) {
      expect(row.applied, `${row.filename} not applied`).toBe(true);
      expect(row.checksumMatches, `${row.filename} checksum drifted`).toBe(true);
    }
  });

  it('arrives with the same vocabularies a stepwise upgrade produces', async () => {
    const { rows: types } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'inventory_movements_type_known'`,
    );
    for (const type of MOVEMENT_TYPES) expect(types[0]?.def).toContain(`'${type}'`);

    const { rows: caps } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'role_capabilities_capability_known'`,
    );
    for (const capability of CAPABILITIES) expect(caps[0]?.def).toContain(`'${capability}'`);
  });

  it('seeds the whole authorization model, including removal', async () => {
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM role_capabilities`,
    );
    const expected = ROLES.reduce(
      (total, role) => total + (DEFAULT_ROLE_CAPABILITIES[role] ?? []).length,
      0,
    );
    expect(Number(rows[0]!.count)).toBe(expected);

    const { rows: removal } = await db.pool.query<{ role: string }>(
      `SELECT role FROM role_capabilities WHERE capability = 'inventory.remove' ORDER BY role`,
    );
    expect(removal.map((r) => r.role)).toEqual(['EMPLOYEE', 'MANAGER', 'OWNER', 'SUPER_ADMIN']);
  });
});
