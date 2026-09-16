-- 0014_application_role.sql
--
-- The privileges the running application holds, as a PostgreSQL role.
--
-- INV-1 says posted movements are immutable, and has said since 0005 that the
-- enforcement is "`BEFORE UPDATE`/`DELETE`/`TRUNCATE` triggers, *planned:* the
-- application database role granted only `SELECT, INSERT`". This is that plan.
-- A trigger is a rule the database applies to a statement it was willing to
-- run; a grant decides whether the statement may be attempted at all. They fail
-- differently and they fail to different things: the trigger catches the
-- application's own bug, and the grant catches everything the trigger cannot —
-- a future migration written carelessly, a `psql` session opened with the
-- application's credentials, an injection that reaches the wire, a leaked
-- connection string. `TRUNCATE` in particular does not fire row triggers in
-- every configuration anybody should be relying on, and a role without the
-- privilege cannot issue it at all.
--
-- Two roles, and the split is the whole design:
--
--   * `ekon_app` — NOLOGIN, created here, holds every privilege the application
--     needs and nothing else. It is a set of permissions with a name. Nobody
--     connects as it.
--   * a LOGIN user per environment, created **outside this file**, put in
--     `ekon_app`:
--
--         CREATE ROLE ekon_runtime LOGIN PASSWORD '<generated per install>';
--         GRANT ekon_app TO ekon_runtime;
--
--     That user is what `DATABASE_URL` names. An installer generates the
--     password on the shop computer; development creates it from
--     `infrastructure/docker/initdb/`; CI creates it in the workflow.
--
-- The login user is deliberately not created here, and this is not a style
-- preference: a migration is committed to a public repository, so any password
-- it contained would be the password of every installation of this product, and
-- one without a password would be an unauthenticated route into the business's
-- records on any cluster that trusts local connections.
--
-- **Migrations do not run as `ekon_app`.** They run as the database owner — the
-- role that created these tables — which is why this file can grant anything at
-- all, and why `DATABASE_URL` for `ekon-ctl migrate` is not the same connection
-- string the service runs with. The owner keeps DDL; the application gets rows.
--
-- Nothing here touches a single row of data, and the migration is re-runnable:
-- every statement either creates something that does not exist or re-grants a
-- privilege that is already held.

BEGIN;

-- The role -----------------------------------------------------------------
--
-- `CREATE ROLE IF NOT EXISTS` does not exist in PostgreSQL, and a role is
-- cluster-wide rather than per-database: a second database on the same cluster
-- (a restore drill, a developer's throwaway test database) will find `ekon_app`
-- already there. So this asks first. `NOLOGIN` is what makes it a permission
-- set rather than an account.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ekon_app') THEN
    CREATE ROLE ekon_app NOLOGIN;

    COMMENT ON ROLE ekon_app IS
      'Privileges held by the Ekon application. NOLOGIN: a LOGIN user is created per environment and granted this role.';
  END IF;
END
$$;

-- Schema access ------------------------------------------------------------
--
-- `USAGE` lets the role see objects in the schema. `CREATE` is deliberately not
-- granted: the application never creates a table, an index, or a function, and
-- a role that cannot create one cannot be used to leave anything behind.
--
-- PostgreSQL 15 and later no longer grant `CREATE ON SCHEMA public` to
-- `PUBLIC`, so on a cluster this product supports there is nothing to revoke.

GRANT USAGE ON SCHEMA public TO ekon_app;

-- The ledger ---------------------------------------------------------------
--
-- `SELECT, INSERT`. Nothing else, ever, by any future migration. No `UPDATE`,
-- no `DELETE`, no `TRUNCATE`, no `REFERENCES`, no `TRIGGER`. A correction is a
-- compensating movement (INV-2); there is no legitimate statement against this
-- table that the two privileges below do not permit.
--
-- An integration test connects as the login user and asserts that this table's
-- grants are exactly these two, and that `UPDATE`, `DELETE`, and `TRUNCATE` are
-- refused. It is written as an assertion about the database rather than about
-- this file, so a later migration that widened it would fail the build.

GRANT SELECT, INSERT ON inventory_movements TO ekon_app;

-- Balances, operations, and counts -----------------------------------------
--
-- The projection is updated in place inside the movement's transaction (INV-5,
-- INV-6), so it needs `UPDATE` — that is what a projection is, and it is safe
-- precisely because the ledger behind it is not. `rebuild-balances` recomputes
-- it from the movements, which is always possible.
--
-- `operations` is claimed on insert and updated once with the result it
-- produced (INV-7). `inventory_count_lines` is inserted when a shelf is counted
-- and updated when a discrepancy is settled (INV-9); its own `BEFORE UPDATE`
-- trigger is what keeps the *observation* immutable, which is a narrower rule
-- than "no updates" and cannot be expressed as a grant.
--
-- None of the three gets `DELETE`. Rows with history are deactivated, never
-- deleted (INV-12), and no code path deletes from any of them.

GRANT SELECT, INSERT, UPDATE ON inventory_balances     TO ekon_app;
GRANT SELECT, INSERT, UPDATE ON operations             TO ekon_app;
GRANT SELECT, INSERT, UPDATE ON inventory_count_lines  TO ekon_app;

-- Locations ----------------------------------------------------------------
--
-- Read-only. `GET /api/inventory/locations` lists them and the posting engine
-- resolves the default; nothing in the application creates, renames, or
-- deactivates one. When a locations workflow is built, its migration grants
-- what it needs and says why.

GRANT SELECT ON inventory_locations TO ekon_app;

-- Identity -----------------------------------------------------------------
--
-- `users`: `SELECT, INSERT, UPDATE`.
--
-- The first two are obvious — accounts are created and read. `UPDATE` is not,
-- because no code path updates a user yet, and it is here for a reason that is
-- easy to remove by accident: **`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`
-- requires it.**
--
-- That lock is what makes "exactly one owner is ever created on a new
-- installation" true. Creating the first owner is a check followed by an
-- insert, and two callers arriving together — two browser tabs on the first-run
-- screen, a tab and the operator command — would otherwise both look, both see
-- nothing, and both write. The username UNIQUE constraint would not catch it:
-- the two owners have different names. PostgreSQL requires `UPDATE`, `DELETE`,
-- or `TRUNCATE` on a table to take a self-conflicting lock on it, and `UPDATE`
-- is the mildest of the three.
--
-- So this grant is part of the concurrency guarantee rather than a workflow's
-- privilege, and an integration test creates owners concurrently against this
-- exact role — which is what would fail if a later migration narrowed it back.
--
-- `DELETE` is never granted: a user with history is deactivated, never deleted
-- (INV-16).
--
-- `sessions`: `SELECT, INSERT, UPDATE`. Signing in writes a row; signing out
-- **revokes** it by setting `revoked_at` rather than deleting it, so `DELETE`
-- is not needed and is not granted. Expired sessions are pruned by an operator
-- task running as the owner, not by the application.
--
-- `role_capabilities`: `SELECT`. The authorization model is seeded by migration
-- and read on every request. An application that could write its own
-- permissions would not have an authorization model.

GRANT SELECT, INSERT, UPDATE ON users             TO ekon_app;
GRANT SELECT, INSERT, UPDATE ON sessions          TO ekon_app;
GRANT SELECT                 ON role_capabilities TO ekon_app;

-- Catalog ------------------------------------------------------------------
--
-- `products` and `product_variants` are created and then edited — a lifecycle
-- status changes, a price is set (INV-19, INV-17) — so both need `UPDATE`. The
-- rules about *what* may change are constraints and triggers on the columns
-- themselves: a SKU is immutable by trigger (INV-13), and a lifecycle
-- transition is checked by the service under a lock. A grant cannot express
-- either, and is not being asked to.
--
-- `variant_attributes` is written when a variant is created and never edited:
-- an attribute is part of a variant's identity, and changing one would change
-- which variant the inventory history is keyed to.

GRANT SELECT, INSERT, UPDATE ON products           TO ekon_app;
GRANT SELECT, INSERT, UPDATE ON product_variants   TO ekon_app;
GRANT SELECT, INSERT         ON variant_attributes TO ekon_app;

-- Merchandise --------------------------------------------------------------
--
-- Brands, classification values, product classifications, and barcodes are
-- created as merchandise is catalogued. The two *vocabularies* —
-- `classification_dimensions` and `variant_attribute_definitions` — are
-- read-only to the application: they are structure, seeded by migration, and a
-- catalog that could invent its own dimensions at runtime is the one that ends
-- up with `color`, `colour`, and `couleur` (INV-18).

GRANT SELECT, INSERT ON brands                  TO ekon_app;
GRANT SELECT, INSERT ON classification_values   TO ekon_app;
GRANT SELECT, INSERT ON product_classifications TO ekon_app;
GRANT SELECT, INSERT ON variant_barcodes        TO ekon_app;
GRANT SELECT ON classification_dimensions     TO ekon_app;
GRANT SELECT ON variant_attribute_definitions TO ekon_app;

-- The migration ledger -----------------------------------------------------
--
-- `SELECT` only. The application reads it at boot to refuse a schema it does
-- not understand (`assertSchemaVersion`) and reports it from `/api/health`. It
-- never writes it: `ekon-ctl migrate` does, as the owner.

GRANT SELECT ON schema_migrations TO ekon_app;

-- Future tables ------------------------------------------------------------
--
-- What a table created by a *later* migration grants `ekon_app` by default.
--
-- Without this, every new table would be invisible to the application until
-- somebody remembered to grant it — and the failure would not appear until a
-- code path touched it, which on a shop computer means at the counter. With it,
-- a new table is readable and writable in the ordinary way and a migration only
-- has to say something when it wants something *different*.
--
-- `SELECT, INSERT, UPDATE`, and deliberately not `DELETE`: nothing in this
-- system deletes a row (INV-12, INV-16), and a default that granted it would
-- make "this table cannot lose rows" true by convention rather than by
-- privilege.
--
-- **A future append-only table must revoke `UPDATE` in its own migration**, the
-- way this one grants the ledger only two privileges. The default is a
-- convenience for ordinary tables, not a statement that ordinary is correct.
--
-- Scope, stated because it is easy to misread: default privileges attach to the
-- role that *creates* the object, not to the schema. This statement runs as
-- whoever is applying migrations, so it covers tables created by that same
-- role — which is the guarantee we want, since that is how every migration
-- runs. If an environment ever applied migrations as a different role, this
-- statement would have to run again as that role, and the grants test is what
-- would notice.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ekon_app;

-- Sequences are not granted, and that is not an oversight: this schema has
-- none. Every identifier is a UUIDv7 generated by the application (ADR 6), and
-- no column is `serial`, `bigserial`, or an identity column. A migration that
-- introduced one would have to grant `USAGE` on it explicitly, which is the
-- right moment to ask whether a database-generated id belongs here at all.

COMMIT;
