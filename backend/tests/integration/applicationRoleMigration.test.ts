import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Migration 0014 — the privileges the running application actually holds.
 *
 * INV-1 has said since 0005 that posted movements are immutable, enforced by
 * triggers, with "the application database role granted only `SELECT, INSERT`"
 * listed as *planned*. This is the test of that plan, and it is written as an
 * assertion about the database rather than about the migration file: a later
 * migration that widened a grant would fail here, which is the only place that
 * would notice.
 *
 * A trigger and a grant catch different failures. The trigger catches this
 * application's own bug. The grant catches everything the trigger cannot — a
 * future migration written carelessly, a `psql` session opened with the
 * application's credentials, an injection that reaches the wire, a leaked
 * connection string — and it catches `TRUNCATE`, which does not fire row
 * triggers.
 *
 * Every assertion below runs on `db.appPool`: the connection an installation
 * uses, as a login user in `ekon_app`. `db.pool` is the owner, and is what
 * applied the migration.
 */

describe('migration 0014 — the application database role', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  /** What `grantee` may do to `table`, as the database reports it. */
  async function grantsOn(table: string, grantee = 'ekon_app'): Promise<string[]> {
    const { rows } = await db.pool.query<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2
        ORDER BY privilege_type`,
      [table, grantee],
    );
    return rows.map((row) => row.privilege_type);
  }

  describe('the role itself', () => {
    it('exists and cannot be logged in as', async () => {
      // `ekon_app` is a set of permissions with a name. The thing that connects
      // is a login user created per environment and put in it — never created
      // by this migration, because a migration is committed to a public
      // repository and a password is not.
      const { rows } = await db.pool.query<{ rolcanlogin: boolean }>(
        `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ekon_app'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rolcanlogin).toBe(false);
    });

    it('is what the application connects as', async () => {
      const { rows } = await db.appPool.query<{ user: string; member: boolean }>(
        `SELECT current_user AS user, pg_has_role(current_user, 'ekon_app', 'member') AS member`,
      );
      expect(rows[0]?.user).not.toBe('ekon');
      expect(rows[0]?.member).toBe(true);
    });

    it('may use the schema but may not create anything in it', async () => {
      const { rows } = await db.appPool.query<{ usage: boolean; create: boolean }>(
        `SELECT has_schema_privilege('ekon_app', 'public', 'USAGE')  AS usage,
                has_schema_privilege('ekon_app', 'public', 'CREATE') AS create`,
      );
      expect(rows[0]?.usage).toBe(true);
      // A role that cannot create a table cannot be used to leave anything behind.
      expect(rows[0]?.create).toBe(false);
    });
  });

  describe('the ledger', () => {
    it('grants exactly SELECT and INSERT on inventory_movements, and nothing else', async () => {
      expect(await grantsOn('inventory_movements')).toEqual(['INSERT', 'SELECT']);
    });

    it('refuses UPDATE, DELETE, and TRUNCATE as the application user', async () => {
      // Not "the trigger raises": the statement never reaches the trigger,
      // because the role may not attempt it. 42501 is `insufficient_privilege`.
      for (const sql of [
        `UPDATE inventory_movements SET note = 'edited'`,
        `DELETE FROM inventory_movements`,
        `TRUNCATE inventory_movements`,
      ]) {
        await expect(db.appPool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('refuses even a statement that would match no rows', async () => {
      // Privilege is checked before the plan runs, which is what makes this a
      // guarantee rather than an accident of an empty table.
      await expect(
        db.appPool.query(`DELETE FROM inventory_movements WHERE id = gen_random_uuid()`),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('still lets the posting engine read and append', async () => {
      // The grant has to be narrow *and* sufficient; a role that could not
      // insert would fail at a counter rather than in a test.
      await expect(
        db.appPool.query(`SELECT count(*) FROM inventory_movements`),
      ).resolves.toBeTruthy();
      const { rows } = await db.appPool.query<{ has: boolean }>(
        `SELECT has_table_privilege('inventory_movements', 'INSERT') AS has`,
      );
      expect(rows[0]?.has).toBe(true);
    });
  });

  describe('everything else', () => {
    it('grants each table the minimum its code paths need', async () => {
      // Audited against the repositories. Where a table gains a workflow that
      // writes differently, the migration that builds it widens this — so the
      // question "what may be written to a user" is answered by a reviewable
      // diff rather than by a privilege granted in advance.
      const expected: Record<string, string[]> = {
        // The projection is updated in place inside the movement's transaction.
        inventory_balances: ['INSERT', 'SELECT', 'UPDATE'],
        // Claimed on insert, updated once with the result it produced.
        operations: ['INSERT', 'SELECT', 'UPDATE'],
        // Inserted when a shelf is counted, updated when a variance is settled.
        inventory_count_lines: ['INSERT', 'SELECT', 'UPDATE'],
        // UPDATE is not a workflow's privilege here — nothing updates a user
        // yet. It is what PostgreSQL requires before a role may take
        // `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, which is the lock
        // that makes "exactly one owner on a new installation" true.
        users: ['INSERT', 'SELECT', 'UPDATE'],
        // Signing out revokes by setting `revoked_at`; nothing deletes a row.
        sessions: ['INSERT', 'SELECT', 'UPDATE'],
        // An application that could write its own permissions would not have an
        // authorization model.
        role_capabilities: ['SELECT'],
        products: ['INSERT', 'SELECT', 'UPDATE'],
        product_variants: ['INSERT', 'SELECT', 'UPDATE'],
        // Part of a variant's identity: written once, never edited.
        variant_attributes: ['INSERT', 'SELECT'],
        brands: ['INSERT', 'SELECT'],
        classification_values: ['INSERT', 'SELECT'],
        product_classifications: ['INSERT', 'SELECT'],
        variant_barcodes: ['INSERT', 'SELECT'],
        // Structure, seeded by migration (INV-18).
        classification_dimensions: ['SELECT'],
        variant_attribute_definitions: ['SELECT'],
        inventory_locations: ['SELECT'],
        // Read at boot and by /api/health; written by `ekon-ctl migrate`.
        schema_migrations: ['SELECT'],
      };

      for (const [table, privileges] of Object.entries(expected)) {
        expect(await grantsOn(table), table).toEqual(privileges);
      }
    });

    it('grants DELETE on nothing at all', async () => {
      // Rows with history are deactivated, never deleted (INV-12, INV-16), and
      // no code path in this system deletes from any table.
      const { rows } = await db.pool.query<{ table_name: string }>(
        `SELECT DISTINCT table_name
           FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = 'ekon_app' AND privilege_type = 'DELETE'`,
      );
      expect(rows.map((row) => row.table_name)).toEqual([]);
    });

    it('grants TRUNCATE on nothing at all', async () => {
      const { rows } = await db.pool.query<{ table_name: string }>(
        `SELECT DISTINCT table_name
           FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = 'ekon_app' AND privilege_type = 'TRUNCATE'`,
      );
      expect(rows.map((row) => row.table_name)).toEqual([]);
    });

    it('leaves no table the application cannot see at all', async () => {
      // A table with no grant is one a code path would fail on at a counter.
      // Every table in the schema is accounted for above; this catches the one
      // a future migration forgets.
      const { rows } = await db.pool.query<{ table_name: string }>(
        `SELECT t.table_name
           FROM information_schema.tables t
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            AND NOT EXISTS (
              SELECT 1 FROM information_schema.role_table_grants g
               WHERE g.table_schema = 'public' AND g.table_name = t.table_name
                 AND g.grantee = 'ekon_app'
            )`,
      );
      expect(rows.map((row) => row.table_name)).toEqual([]);
    });
  });

  describe('the lock first-run setup depends on', () => {
    it('can be taken by the application role', async () => {
      // `SHARE ROW EXCLUSIVE` is self-conflicting, which is what serializes two
      // browser tabs both creating the first owner. PostgreSQL requires
      // UPDATE, DELETE, or TRUNCATE on the table before a role may take it, so
      // a migration that narrowed `users` back to SELECT, INSERT would turn the
      // concurrency guarantee into a 500 — visible here rather than on the day
      // somebody sets up a shop.
      const client = await db.appPool.connect();
      try {
        await client.query('BEGIN');
        await expect(
          client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE'),
        ).resolves.toBeTruthy();
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('tables a future migration creates', () => {
    it('are readable and writable by the application without anybody remembering', async () => {
      // Without default privileges, a new table would be invisible to the
      // application until somebody granted it — and the failure would not
      // appear until a code path touched it, which on a shop computer means at
      // the counter.
      await db.pool.query(`CREATE TABLE later_migration_table (id uuid PRIMARY KEY)`);
      try {
        expect(await grantsOn('later_migration_table')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      } finally {
        await db.pool.query(`DROP TABLE later_migration_table`);
      }
    });

    it('do not get DELETE by default', async () => {
      await db.pool.query(`CREATE TABLE later_deletable_table (id uuid PRIMARY KEY)`);
      try {
        expect(await grantsOn('later_deletable_table')).not.toContain('DELETE');
      } finally {
        await db.pool.query(`DROP TABLE later_deletable_table`);
      }
    });
  });
});
