import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITIES, DEFAULT_ROLE_CAPABILITIES, ROLES } from '@ekon/shared';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0015 — `system.manage`, granted to `SUPER_ADMIN` and `OWNER`.
 *
 * The capability vocabulary is written out by hand in three places that cannot
 * import one another: a CHECK constraint, a seed of grants, and
 * `@ekon/shared`. This is what keeps them from drifting — and it is the parity
 * test for the **current head**, which is why the equivalent assertions in
 * `inventoryRemovalMigration.test.ts` are scoped to the database as it stood at
 * 0008.
 */

describe('migration 0015 — the system capability', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  /** The string literals a CHECK constraint names. */
  async function checkConstraintLiterals(constraint: string): Promise<string[]> {
    const { rows } = await db.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1`,
      [constraint],
    );
    const definition = rows[0]?.definition;
    if (definition === undefined) throw new Error(`No constraint named ${constraint}`);
    return [...definition.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
  }

  async function grants(): Promise<{ role: string; capability: string }[]> {
    const { rows } = await db.pool.query<{ role: string; capability: string }>(
      `SELECT role, capability FROM role_capabilities ORDER BY role, capability`,
    );
    return rows;
  }

  it('names exactly the shared capability vocabulary', async () => {
    const inDatabase = await checkConstraintLiterals('role_capabilities_capability_known');
    expect([...new Set(inDatabase)].sort()).toEqual([...CAPABILITIES].sort());
    expect(inDatabase).toContain('system.manage');
  });

  it('seeds exactly DEFAULT_ROLE_CAPABILITIES', async () => {
    const mapping: Record<string, string[]> = {};
    for (const row of await grants()) (mapping[row.role] ??= []).push(row.capability);

    const expected: Record<string, string[]> = {};
    for (const role of ROLES) expected[role] = [...(DEFAULT_ROLE_CAPABILITIES[role] ?? [])].sort();

    expect(mapping).toEqual(expected);
  });

  it('gives it to the owner and the super admin, and to nobody else', async () => {
    // A manager runs the shop floor. Whether the business could survive losing
    // the computer is the owner's question, and the person who would act on a
    // failed backup is the person who owns the records. A shop that wants a
    // manager watching it grants this later; starting narrow and widening is
    // the direction that works.
    const holders = (await grants())
      .filter((row) => row.capability === 'system.manage')
      .map((row) => row.role)
      .sort();

    expect(holders).toEqual(['OWNER', 'SUPER_ADMIN']);
  });

  it('revokes nothing', async () => {
    // 0015 widens a CHECK and inserts two rows. Every grant 0007 and 0008 made
    // is still there.
    const all = await grants();
    for (const role of ROLES) {
      for (const capability of DEFAULT_ROLE_CAPABILITIES[role] ?? []) {
        expect(
          all.some((row) => row.role === role && row.capability === capability),
          `${role} lost ${capability}`,
        ).toBe(true);
      }
    }
  });

  it('still refuses a capability nobody defined', async () => {
    // The vocabulary is wider, not open.
    await expect(
      db.pool.query(
        `INSERT INTO role_capabilities (role, capability) VALUES ('OWNER', 'system.destroy')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
