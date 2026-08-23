-- 0010_controlled_variant_attributes.sql
--
-- Closes the bridge 0009 left open: `variant_attribute_definitions` becomes the
-- controlled vocabulary that new variant attributes must come from.
--
-- Two statements, and a great deal of care about the second one.
--
--   1. Seed the initial vocabulary — `color`, `size`, `width`, `material` —
--      with literal application-shaped ids, the way 0004 seeds the default
--      location and 0009 seeds the classification dimensions.
--
--   2. Add a foreign key from `variant_attributes.attribute_name` onto it,
--      `NOT VALID`, so every future write is checked by the database while every
--      row already stored stays exactly as it is and stays readable.
--
-- Nothing is deleted, nothing is renamed, and no signature is recomputed.
-- `variant_signature` is built from attribute names and values, so rewriting a
-- name would silently change what variant a row identifies and orphan the
-- inventory history keyed to it.

BEGIN;

-- The initial vocabulary ---------------------------------------------------
--
-- Four names, because four names cover the merchandise this shop actually
-- sells: footwear varies by colour, size and width; handbags by colour and
-- material; socks by colour and size (ADR 11). This is a starting vocabulary,
-- not a claim that merchandise never varies any other way.
--
-- Stored in exactly the form `variant_attributes.attribute_name` uses —
-- trimmed and lower-cased (0002) — which is what lets the foreign key below
-- point at the name rather than at an id.
--
-- Ids and timestamps are literal rather than generated. A migration must
-- produce the same rows in every environment and on every replay, and ids in
-- this system are UUIDv7 written by application code, never `gen_random_uuid()`
-- (0001). Application code finds a definition by name, never by a hard-coded
-- id — the same rule 0004 states for the default location.
--
-- Deliberately NOT seeded from `SELECT DISTINCT attribute_name FROM
-- variant_attributes`: that would need an id per row invented in SQL, and it
-- would promote whatever is already stored — including anything typed into a
-- test environment — into the vocabulary the business is supposed to control.

INSERT INTO variant_attribute_definitions (id, name, created_at, updated_at) VALUES
  ('01a03111-1c00-7b01-8b01-5c3f7e2d1b01', 'color',    '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'),
  ('01a03111-1c00-7b02-8b02-5c3f7e2d1b02', 'material', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'),
  ('01a03111-1c00-7b03-8b03-5c3f7e2d1b03', 'size',     '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'),
  ('01a03111-1c00-7b04-8b04-5c3f7e2d1b04', 'width',    '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z')
ON CONFLICT (name) DO NOTHING;

-- The key, and why it is NOT VALID -----------------------------------------
--
-- The key points at `variant_attribute_definitions (name)` rather than at its
-- id, and `variant_attributes` gains no new column. That is what makes this
-- migration additive at all: the alternative is a `definition_id` column that
-- has to be backfilled for every row already stored, with an id per distinct
-- name invented in SQL. `name` is already the identity — it is what
-- `variant_signature` is built from and what the unique constraint on
-- definitions is on — so a natural-key reference states the relationship that
-- is actually there instead of manufacturing a second one.
--
-- NOT VALID means: PostgreSQL enforces this on every INSERT and UPDATE from now
-- on, and does not scan what is already there. Both halves are wanted.
--
--   Every new write is controlled, by the database and not by a service check
--   somebody can forget to call.
--
--   Every attribute already stored stays readable, keeps its name and value,
--   and keeps its place in its variant's signature — including names that
--   predate any vocabulary. A migration that refused to apply because a staging
--   database contained `gwosè` would block the deploy over data nobody has
--   reviewed yet, and a migration that deleted or renamed such a row would
--   change what its variant is.
--
-- 0008 says of a different constraint that NOT VALID was deliberately avoided,
-- and that reasoning does not transfer. There, it would have been used to skip
-- a scan over rows that were all known to be good, buying a shorter lock at the
-- cost of a window in which the ledger accepted unchecked values. Here the
-- existing rows are genuinely unverified and must stay, and NOT VALID is not a
-- deferral of the check but a statement of its exact scope.
--
-- WHEN FULL ENFORCEMENT BECOMES POSSIBLE: when every distinct name in
-- `variant_attributes` has a definition. That is an operator task — read the
-- distinct names, decide which are real merchandise attributes and which were
-- mistakes, define the real ones — and it completes with
--
--     ALTER TABLE variant_attributes VALIDATE CONSTRAINT
--       variant_attributes_name_defined_fk;
--
-- which scans without an exclusive lock on writers and, once it succeeds,
-- leaves an ordinary fully-valid foreign key. On a fresh installation there is
-- nothing to review and that statement would pass today; it is not run here
-- because a migration cannot know which installation it is on.
--
-- ON DELETE RESTRICT, and ON UPDATE RESTRICT: a definition in use cannot be
-- removed, and its name cannot change. Renaming `color` would rewrite the
-- identity of every variant that carries one.

ALTER TABLE variant_attributes
  ADD CONSTRAINT variant_attributes_name_defined_fk
  FOREIGN KEY (attribute_name)
  REFERENCES variant_attribute_definitions (name)
  ON DELETE RESTRICT
  ON UPDATE RESTRICT
  NOT VALID;

COMMIT;
