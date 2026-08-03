-- 0004_inventory_locations.sql
--
-- Inventory locations: the places stock can sit. Locations belong to the
-- inventory module; there is no separate location module. This migration creates
-- the table and seeds exactly one default location for a fresh installation.
--
-- Scope is deliberately narrow. No movement, balance, or count tables here, and
-- no product-to-location assignment — those arrive with the ledger. Future
-- movement foreign keys will reference this table with ON DELETE RESTRICT, and
-- locations will deactivate rather than delete once they carry history.
--
-- Conventions from 0001–0003 apply: uuid primary key generated in application
-- code (no database default), timestamptz, boolean NOT NULL DEFAULT, text + CHECK
-- rather than native enums.

BEGIN;

CREATE TABLE inventory_locations (
  id         uuid        PRIMARY KEY,
  name       text        NOT NULL,
  is_default boolean     NOT NULL DEFAULT false,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,

  -- Name is required after trimming and bounded. The application trims before
  -- insert; these checks make the invariant true regardless of the caller.
  CONSTRAINT inventory_locations_name_trimmed   CHECK (name = btrim(name)),
  CONSTRAINT inventory_locations_name_not_blank CHECK (length(name) > 0),
  CONSTRAINT inventory_locations_name_max_len   CHECK (length(name) <= 120)
);

-- At most one default location. Partial unique index rather than a trigger: the
-- database never has to guarantee a default exists, only that two never do.
CREATE UNIQUE INDEX inventory_locations_one_default_idx
  ON inventory_locations (is_default)
  WHERE is_default = true;

-- Seed exactly one default location for the initial installation. Explicit id
-- and timestamps, never a database default or now(): a migration must produce
-- the same rows on every environment and every replay. Application code must
-- discover the default from the database, not hard-code this id.
INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
VALUES (
  '019fc8e6-d1f0-7b81-8cf3-cbfa9a9df78a',
  'Main Store',
  true,
  true,
  '2026-08-01T00:00:00Z',
  '2026-08-01T00:00:00Z'
);

COMMIT;
