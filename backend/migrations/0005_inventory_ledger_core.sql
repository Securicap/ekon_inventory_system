-- 0005_inventory_ledger_core.sql
--
-- The inventory ledger core. Three tables:
--
--   * `operations`          — one row per state-changing command, so a retried
--                             request applies at most once (INV-7).
--   * `inventory_movements` — the append-only history of every stock change.
--                             This is the source of truth; nothing else is.
--   * `inventory_balances`  — a mutable projection of that history, one row per
--                             (variant, location), maintained in the same
--                             transaction as the movement that changes it.
--
-- Inventory is always held per (product variant, inventory location). Both of
-- those tables already exist (0002, 0004) and are referenced here with
-- ON DELETE RESTRICT: a row that carries stock history is deactivated, never
-- deleted.
--
-- Scope is deliberately narrow. This migration creates the schema and the
-- invariants that protect it. There is no posting engine yet — no service, no
-- repository, no endpoint writes these tables. The next PR adds the internal
-- posting engine that this schema is shaped for; receiving, adjustments,
-- counts, public reversal, and the balance API come after it.
--
-- Conventions from 0001 apply: uuid primary keys generated in application code
-- (no database defaults), timestamptz everywhere, integer quantities in whole
-- base units, text + CHECK instead of native enums, and no JSON store for
-- structured data.

BEGIN;

-- Operations ---------------------------------------------------------------
--
-- Idempotency, and nothing else. The client generates the operation id when the
-- form opens and reuses it for every retry, including after a page reload. The
-- posting engine will write this row with
-- `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING *`: no row returned means
-- this command already applied, so compare `request_hash` and either return the
-- recorded result or reject a body that differs. Never check-then-insert, which
-- races (INV-7).
--
-- There is deliberately no status, attempt counter, request or response
-- payload, error column, or workflow state. Those turn an idempotency key into
-- a job queue, and this is not a job queue. The result pointer is the minimum
-- needed to answer a replayed request: what was created, and which one.

CREATE TABLE operations (
  id                   uuid        PRIMARY KEY,
  operation_type       text        NOT NULL,
  request_hash         text        NOT NULL,
  result_resource_type text,
  result_resource_id   uuid,
  created_at           timestamptz NOT NULL,

  -- Text fields are stored trimmed and bounded, regardless of the caller.
  CONSTRAINT operations_type_trimmed   CHECK (operation_type = btrim(operation_type)),
  CONSTRAINT operations_type_not_blank CHECK (length(operation_type) > 0),
  CONSTRAINT operations_type_max_len   CHECK (length(operation_type) <= 60),

  -- A hex digest of the canonical request body. 64 characters for sha-256; the
  -- bound leaves room for a longer digest without a schema change.
  CONSTRAINT operations_request_hash_trimmed   CHECK (request_hash = btrim(request_hash)),
  CONSTRAINT operations_request_hash_not_blank CHECK (length(request_hash) > 0),
  CONSTRAINT operations_request_hash_max_len   CHECK (length(request_hash) <= 128),

  CONSTRAINT operations_result_type_trimmed CHECK (
    result_resource_type IS NULL OR result_resource_type = btrim(result_resource_type)
  ),
  CONSTRAINT operations_result_type_not_blank CHECK (
    result_resource_type IS NULL OR length(result_resource_type) > 0
  ),
  CONSTRAINT operations_result_type_max_len CHECK (
    result_resource_type IS NULL OR length(result_resource_type) <= 60
  ),

  -- A result pointer is a pair. A type without an id, or an id without a type,
  -- cannot answer a replayed request.
  CONSTRAINT operations_result_pointer_complete CHECK (
    (result_resource_type IS NULL) = (result_resource_id IS NULL)
  )
);

-- Inventory movements ------------------------------------------------------
--
-- Append-only. Every row records what the quantity was, what changed, and what
-- it became, so history can be read without replaying anything. Corrections are
-- compensating movements (INV-1, INV-2).
--
-- `user_id` is required but carries no foreign key: identity does not exist
-- yet. It is added when the users table lands. No placeholder table and no
-- fake actor row is invented here to make a constraint compile — a foreign key
-- pointing at a fiction is worse than no foreign key at all.

CREATE TABLE inventory_movements (
  id                   uuid        PRIMARY KEY,
  variant_id           uuid        NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  location_id          uuid        NOT NULL REFERENCES inventory_locations (id) ON DELETE RESTRICT,
  movement_type        text        NOT NULL,
  quantity_delta       integer     NOT NULL,
  quantity_before      integer     NOT NULL,
  quantity_after       integer     NOT NULL,
  previous_movement_id uuid,
  reverses_movement_id uuid        REFERENCES inventory_movements (id) ON DELETE RESTRICT,
  operation_id         uuid        NOT NULL REFERENCES operations (id) ON DELETE RESTRICT,
  reason_code          text,
  note                 text,
  user_id              uuid        NOT NULL,
  device_id            uuid        NOT NULL,
  occurred_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL,

  -- The closed vocabulary, identical to MOVEMENT_TYPES in
  -- `shared/src/movements.ts`. A test asserts the two sets are equal, so the
  -- database and the wire format cannot drift apart.
  CONSTRAINT inventory_movements_type_known CHECK (
    movement_type IN ('RECEIPT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'COUNT_RECONCILIATION', 'REVERSAL')
  ),

  -- A movement that changes nothing is not a movement. A count that finds the
  -- expected quantity records a count line and posts no movement at all.
  CONSTRAINT inventory_movements_delta_not_zero CHECK (quantity_delta <> 0),

  -- Stock never goes below zero, for any role, by any path (INV-8).
  CONSTRAINT inventory_movements_before_non_negative CHECK (quantity_before >= 0),
  CONSTRAINT inventory_movements_after_non_negative  CHECK (quantity_after >= 0),

  -- The row is arithmetically self-consistent (INV-3).
  CONSTRAINT inventory_movements_arithmetic CHECK (
    quantity_after = quantity_before + quantity_delta
  ),

  -- Every adjustment says why. Receipts, counts, and reversals carry their
  -- reason in their type or in the movement they reverse. Mirrors
  -- REASON_REQUIRED_MOVEMENT_TYPES in `shared/src/movements.ts` (INV-11).
  CONSTRAINT inventory_movements_adjustment_requires_reason CHECK (
    movement_type NOT IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT') OR reason_code IS NOT NULL
  ),

  CONSTRAINT inventory_movements_reason_trimmed CHECK (
    reason_code IS NULL OR reason_code = btrim(reason_code)
  ),
  CONSTRAINT inventory_movements_reason_not_blank CHECK (
    reason_code IS NULL OR length(reason_code) > 0
  ),
  CONSTRAINT inventory_movements_reason_max_len CHECK (
    reason_code IS NULL OR length(reason_code) <= 60
  ),

  -- A note is free text a clerk types at the counter, so it is bounded but not
  -- otherwise policed.
  CONSTRAINT inventory_movements_note_max_len CHECK (note IS NULL OR length(note) <= 500),

  -- Reversal shape, both directions: a REVERSAL names the movement it reverses,
  -- and nothing else may claim to reverse anything.
  CONSTRAINT inventory_movements_reversal_names_original CHECK (
    movement_type <> 'REVERSAL' OR reverses_movement_id IS NOT NULL
  ),
  CONSTRAINT inventory_movements_non_reversal_reverses_nothing CHECK (
    movement_type = 'REVERSAL' OR reverses_movement_id IS NULL
  ),
  CONSTRAINT inventory_movements_reverses_not_self CHECK (
    reverses_movement_id IS NULL OR reverses_movement_id <> id
  ),

  -- One original movement is reversed at most once. Two reversals of the same
  -- receipt would remove the stock twice (INV-2). NULLs are distinct in
  -- Postgres, so any number of non-reversal movements coexist.
  CONSTRAINT inventory_movements_reverses_once UNIQUE (reverses_movement_id),

  -- The chain cannot loop back on itself in a single row.
  CONSTRAINT inventory_movements_previous_not_self CHECK (
    previous_movement_id IS NULL OR previous_movement_id <> id
  ),

  -- Movements for one (variant, location) form a strict chain: each movement
  -- names its predecessor, and a predecessor has at most one successor. Two
  -- concurrent writers reading the same current movement both try to claim it
  -- as their predecessor; the second one fails here rather than producing two
  -- rows that both believe they started from the same quantity (INV-4).
  CONSTRAINT inventory_movements_one_successor UNIQUE (previous_movement_id),

  -- Referenced by the composite foreign keys below. Redundant with the primary
  -- key on its own, but a foreign key needs a unique key on exactly the columns
  -- it references.
  CONSTRAINT inventory_movements_chain_key UNIQUE (id, variant_id, location_id)
);

-- The predecessor must belong to the same chain. Without the variant and
-- location in the foreign key, a movement could name a predecessor from another
-- product or another location and inherit a quantity that has nothing to do
-- with its own shelf.
--
-- MATCH SIMPLE (the default) means the constraint is not checked when
-- `previous_movement_id` is NULL, which is exactly the opening movement of a
-- chain — the case that legitimately has no predecessor.
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_previous_same_chain_fk
  FOREIGN KEY (previous_movement_id, variant_id, location_id)
  REFERENCES inventory_movements (id, variant_id, location_id)
  ON DELETE RESTRICT;

-- Exactly one movement per chain may have no predecessor. Combined with
-- `inventory_movements_one_successor`, the movements of a (variant, location)
-- are a single line with one head, never a fork and never two parallel
-- histories (INV-4).
CREATE UNIQUE INDEX inventory_movements_one_opening_idx
  ON inventory_movements (variant_id, location_id)
  WHERE previous_movement_id IS NULL;

-- Reading one shelf's history in order. Also serves the foreign key from
-- product_variants, whose column leads the index.
CREATE INDEX inventory_movements_chain_idx
  ON inventory_movements (variant_id, location_id, recorded_at);

-- Postgres does not index a foreign-key column automatically. These two support
-- the ON DELETE RESTRICT checks and lookups by location or by operation.
CREATE INDEX inventory_movements_location_id_idx  ON inventory_movements (location_id);
CREATE INDEX inventory_movements_operation_id_idx ON inventory_movements (operation_id);

-- Inventory balances -------------------------------------------------------
--
-- A projection, not a source of truth. For every (variant, location):
-- `quantity_on_hand = SUM(quantity_delta)` over that chain (INV-6). The posting
-- engine updates this row in the same transaction as the movement insert, under
-- SELECT ... FOR UPDATE; because the ledger is immutable, this table can always
-- be rebuilt from it.
--
-- No rows are seeded. A balance row appears the first time stock moves onto a
-- (variant, location); an absent row means zero and has always meant zero.

CREATE TABLE inventory_balances (
  variant_id       uuid        NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  location_id      uuid        NOT NULL REFERENCES inventory_locations (id) ON DELETE RESTRICT,
  quantity_on_hand integer     NOT NULL,
  last_movement_id uuid,
  updated_at       timestamptz NOT NULL,

  PRIMARY KEY (variant_id, location_id),

  -- A shelf cannot hold minus three items (INV-8). There is deliberately no
  -- capability that grants an override.
  CONSTRAINT inventory_balances_quantity_non_negative CHECK (quantity_on_hand >= 0),

  -- Stock that exists came from somewhere. A zero balance may keep its pointer:
  -- stock drawn back down to zero still has a last movement.
  CONSTRAINT inventory_balances_nonzero_has_movement CHECK (
    quantity_on_hand = 0 OR last_movement_id IS NOT NULL
  )
);

CREATE INDEX inventory_balances_location_id_idx ON inventory_balances (location_id);

-- The balance's last movement must belong to that balance's own chain. A
-- pointer into another variant's or another location's history would make the
-- projection unverifiable against the ledger it claims to summarize. Added
-- after both tables exist, because it references one from the other.
ALTER TABLE inventory_balances
  ADD CONSTRAINT inventory_balances_last_movement_same_chain_fk
  FOREIGN KEY (last_movement_id, variant_id, location_id)
  REFERENCES inventory_movements (id, variant_id, location_id)
  ON DELETE RESTRICT;

-- Append-only protection ---------------------------------------------------
--
-- INV-1, enforced by the database rather than by convention. The application
-- role will additionally be granted only SELECT and INSERT on this table once
-- roles exist; these triggers hold even against the migration owner.
--
-- Scoped to this one table on purpose. There is no generic immutable-table
-- framework here: `inventory_movements` is the table the whole system rests on,
-- and a general mechanism would invite marking other tables immutable without
-- thinking about what that costs.

CREATE FUNCTION inventory_reject_movement_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'inventory_movements is append-only: posted inventory movements are immutable and % is never permitted. Correct a mistake with a compensating movement — post a REVERSAL of the wrong movement, then the correct one. History is never edited.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER inventory_movements_no_update
  BEFORE UPDATE ON inventory_movements
  FOR EACH ROW
  EXECUTE FUNCTION inventory_reject_movement_mutation();

CREATE TRIGGER inventory_movements_no_delete
  BEFORE DELETE ON inventory_movements
  FOR EACH ROW
  EXECUTE FUNCTION inventory_reject_movement_mutation();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own
-- statement-level trigger. Without it, the one command that erases the whole
-- ledger would be the one command the ledger does not defend against.
CREATE TRIGGER inventory_movements_no_truncate
  BEFORE TRUNCATE ON inventory_movements
  FOR EACH STATEMENT
  EXECUTE FUNCTION inventory_reject_movement_mutation();

COMMIT;
