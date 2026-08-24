-- 0013_physical_count_lines.sql
--
-- Physical counts: what somebody saw on a shelf, what Ekon expected at that
-- moment, and what the shop decided about the difference.
--
--     SYSTEM EXPECTED  +  PHYSICAL OBSERVATION
--                ↓
--            DISCREPANCY
--                ↓
--          INVESTIGATION
--                ↓
--     RECONCILIATION DECISION
--                ↓
--     COUNT_RECONCILIATION movement, if the variance is not zero
--
-- INV-9 has been a stated principle since 0005 and has had nothing to enforce
-- it: the posting engine could already write a `COUNT_RECONCILIATION`, and
-- there was nowhere to record what was counted, what was expected, or why a
-- difference was accepted. This migration is where that principle becomes a
-- table with constraints on it.
--
-- **A count observes. Investigation explains. Reconciliation changes stock.**
-- Recording that six were seen where seven were expected must not make the
-- balance six — that would destroy the only signal the shop had, which is that
-- one unit is unaccounted for. So the observation is stored here, the ledger is
-- untouched until somebody accepts the variance, and the two are then written
-- in one transaction.
--
-- Strictly additive to everything that exists. No movement is rewritten, no
-- balance is recomputed, no id is re-keyed, and no row of any existing table is
-- updated. The one change outside the new table widens a CHECK on
-- `inventory_movements`, which is discussed where it happens.
--
-- Conventions from 0001 apply: uuid primary keys generated in application code,
-- timestamptz with application-supplied values rather than now(), integer
-- quantities in whole base units, text + CHECK instead of native enums, and
-- ON DELETE RESTRICT onto rows that carry history.

BEGIN;

-- Count lines ---------------------------------------------------------------
--
-- `inventory_count_lines`, and the name is deliberate. It is a **line**: one
-- variant, one location, one observation. It is not `inventory_counts`, which
-- would promise a count *document* — a session with a scope, a status, a set of
-- lines and somebody who closed it. OR1 has no such thing, and a table named
-- for one would be an invitation to build it by accident.
--
-- Each row answers every question the workflow has to be able to answer: what
-- was counted, where, by whom, when it was counted, when Ekon recorded it, what
-- Ekon expected, what was seen, what the difference was, whether it is still
-- unresolved, who accepted it, why, and which movement resulted.

CREATE TABLE inventory_count_lines (
  id          uuid NOT NULL PRIMARY KEY,

  -- What was counted, and where. ON DELETE RESTRICT because a count is history
  -- (INV-12): merchandise somebody has counted, and a shelf somebody has
  -- counted it on, cannot be deleted out from under the evidence.
  variant_id  uuid NOT NULL REFERENCES product_variants (id)   ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES inventory_locations (id) ON DELETE RESTRICT,

  -- What Ekon held for that shelf at the moment the observation was recorded,
  -- and what was physically there. Both are whole units and neither can be
  -- negative: a shelf cannot hold minus three items, and a person cannot count
  -- minus three of them either.
  --
  -- `expected_quantity` is the heart of INV-9 and is **server-owned**. It is
  -- read from `inventory_balances` inside the recording transaction; no request
  -- schema accepts one. A caller that could supply it could manufacture any
  -- variance it liked, and the variance is the entire evidentiary content of
  -- the row.
  expected_quantity integer NOT NULL,
  counted_quantity  integer NOT NULL,

  -- The difference, computed by the database and by nothing else.
  --
  -- A generated column rather than a third number the application keeps in
  -- step: three independent integers can disagree, and the day they do there is
  -- no way to tell which two were right. This cannot drift, cannot be inserted,
  -- and cannot be updated — PostgreSQL rejects any attempt to write it.
  variance integer GENERATED ALWAYS AS (counted_quantity - expected_quantity) STORED,

  -- Who counted, and the two times. `counted_at` is business time — when the
  -- shelf was actually walked, which is routinely earlier than when somebody
  -- reached a computer. `recorded_at` is server time, read from the injected
  -- clock inside the transaction, never `now()` in SQL (INV-11's rule, applied
  -- to evidence that is not a movement).
  --
  -- This foreign key onto `users` is one the ledger still cannot have: movements
  -- predate the identity module and carry actor uuids that were never accounts,
  -- so `inventory_movements.user_id` has no key (INV-11). This table has no such
  -- history — its first row is written by this application, against a real
  -- session — so the key is added where it can be honoured rather than deferred
  -- out of symmetry. ON DELETE RESTRICT: a person who counted stock cannot be
  -- deleted, which is INV-16 applied to counting.
  counted_by_user_id uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  counted_at         timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL,

  -- The command that recorded this observation. A count moves no stock, but it
  -- is durable business evidence, and a dropped connection must not leave two
  -- records of one shelf-check — so recording claims an `operations` row exactly
  -- as every stock command does (INV-7), with its own operation type and a
  -- result pointer back to this row.
  --
  -- UNIQUE rather than merely referenced: one operation produces one count line,
  -- which is the same statement `operations.id` makes from the other side and is
  -- the index a replay lookup uses.
  operation_id uuid NOT NULL UNIQUE REFERENCES operations (id) ON DELETE RESTRICT,

  -- What became of the discrepancy. All five are NULL together until somebody
  -- accepts it, and all five are set together when they do.
  reconciliation_reason       text,
  reconciliation_note         text,
  reconciled_by_user_id       uuid REFERENCES users (id) ON DELETE RESTRICT,
  reconciled_at               timestamptz,
  reconciliation_operation_id uuid UNIQUE REFERENCES operations (id) ON DELETE RESTRICT,

  -- The movement that changed the stock when the discrepancy was accepted.
  --
  -- **One pointer, on this side, and none on the movement.** The relationship is
  -- one-to-at-most-one in both directions, so a second column on
  -- `inventory_movements` would be a second authority for one fact — and the
  -- ledger is the table that must never carry a fact it does not need. Reading
  -- it the other way (which count produced this movement?) is a join through
  -- the unique index below, which is exactly how 0005's
  -- `UNIQUE (reverses_movement_id)` is read backwards to answer "was this
  -- movement reversed?".
  reconciliation_movement_id uuid UNIQUE,

  -- The movement's type, derived by the database so the foreign key below can
  -- check it. It is not data — it is a constraint's working column, and unlike
  -- 0009's and 0012's denormalized columns it cannot even be written wrongly,
  -- because PostgreSQL computes it. The same technique, one step safer.
  reconciliation_movement_type text GENERATED ALWAYS AS (
    CASE WHEN reconciliation_movement_id IS NULL THEN NULL ELSE 'COUNT_RECONCILIATION' END
  ) STORED,

  -- What this row *is*, derived from the numbers and the decision rather than
  -- chosen by anybody.
  --
  --   MATCHED     the shelf agreed with the record. Settled on arrival: nothing
  --               to investigate, nothing to accept, nothing to post.
  --   OPEN        a variance nobody has resolved yet.
  --   RECONCILED  a variance somebody explicitly accepted.
  --
  -- Generated, so it cannot disagree with the variance beside it and no code
  -- path can set it directly. A status somebody writes is a status somebody
  -- eventually writes wrongly, and this one governs whether a discrepancy is
  -- visible to the people whose job is to chase it.
  --
  -- MATCHED and RECONCILED are deliberately not one "settled" value: nothing was
  -- decided about a match, and calling it reconciled would attribute a judgement
  -- to somebody who never made one. Identical to COUNT_STATUSES in
  -- `shared/src/counts.ts`; a test compares the two.
  status text GENERATED ALWAYS AS (
    CASE
      WHEN counted_quantity = expected_quantity THEN 'MATCHED'
      WHEN reconciled_at IS NULL                THEN 'OPEN'
      ELSE 'RECONCILED'
    END
  ) STORED,

  -- Quantities are whole units and never negative (INV-10, and the same floor
  -- INV-8 puts under the ledger). The `integer` type supplies the ceiling.
  CONSTRAINT inventory_count_lines_expected_non_negative CHECK (expected_quantity >= 0),
  CONSTRAINT inventory_count_lines_counted_non_negative  CHECK (counted_quantity >= 0),

  -- The reconciliation vocabulary. Identical to COUNT_RECONCILIATION_REASONS in
  -- `shared/src/counts.ts`, and a test asserts the two sets are equal so the
  -- database and the wire format cannot drift apart.
  --
  -- `COUNTING_ERROR` is deliberately absent, and it is the most important
  -- omission in this file. If the count itself was wrong then the shelf never
  -- differed and there is nothing to accept; the answer is to count again and
  -- record a *new* observation, leaving both the mistaken count and the
  -- corrected one as evidence. A reason that let somebody post a stock movement
  -- derived from a quantity they believe is false would make this workflow a way
  -- of laundering bad data through the ledger.
  --
  -- `SHRINKAGE` and not `THEFT`: a count can establish that stock is gone and
  -- cannot establish who took it. The note is where somebody writes what was
  -- actually found.
  CONSTRAINT inventory_count_lines_reason_known CHECK (
    reconciliation_reason IS NULL OR reconciliation_reason IN (
      'UNRECORDED_SALE',
      'MISSED_RECEIPT',
      'DAMAGED',
      'MISPLACED_STOCK',
      'SHRINKAGE',
      'DATA_ENTRY_ERROR',
      'OTHER'
    )
  ),

  -- A note is free text somebody typed, so it is bounded and non-blank but not
  -- otherwise policed. Same shape and same 500-character bound as a movement's
  -- (0005), because it is the same kind of thing written by the same people.
  CONSTRAINT inventory_count_lines_note_trimmed   CHECK (
    reconciliation_note IS NULL OR reconciliation_note = btrim(reconciliation_note)
  ),
  CONSTRAINT inventory_count_lines_note_not_blank CHECK (
    reconciliation_note IS NULL OR length(reconciliation_note) > 0
  ),
  CONSTRAINT inventory_count_lines_note_max_len   CHECK (
    reconciliation_note IS NULL OR length(reconciliation_note) <= 500
  ),

  -- `OTHER` is the one reason that says nothing on its own, so it says it in the
  -- note or it is not recorded. The same discipline the adjustment workflow
  -- applies, enforced here in the database because this decision moved stock.
  CONSTRAINT inventory_count_lines_other_requires_note CHECK (
    reconciliation_reason IS DISTINCT FROM 'OTHER' OR reconciliation_note IS NOT NULL
  ),

  -- A reconciliation is a complete fact or it is absent. Four columns, all NULL
  -- or all set: a decision with no reason, a reason with nobody behind it, or a
  -- reconciliation nobody can date are each half a record, and half a record of
  -- a stock change is worse than none.
  CONSTRAINT inventory_count_lines_reconciliation_complete CHECK (
    num_nonnulls(
      reconciliation_reason,
      reconciled_by_user_id,
      reconciled_at,
      reconciliation_operation_id
    ) IN (0, 4)
  ),

  -- **A settled discrepancy has a movement, and a movement means a settled
  -- discrepancy.** This is the atomicity invariant expressed as a row rule: it
  -- is impossible to store `RECONCILED` without the movement that carried it,
  -- and impossible to name a movement while the count still reads `OPEN`.
  -- Together with the single transaction the application uses, that is what
  -- makes count settlement and stock reconciliation one fact rather than two
  -- that usually agree.
  CONSTRAINT inventory_count_lines_settled_has_movement CHECK (
    (reconciled_at IS NULL) = (reconciliation_movement_id IS NULL)
  ),

  -- **A match is never reconciled.** Zero variance means the shelf agreed with
  -- the record: there is nothing to accept, and a movement of zero is not a
  -- movement — the ledger's own `CHECK (quantity_delta <> 0)` (0005) would
  -- refuse one anyway. This stops the workflow from inventing a decision, and a
  -- ledger row, for a shelf that was simply right.
  CONSTRAINT inventory_count_lines_match_is_settled CHECK (
    counted_quantity <> expected_quantity OR reconciled_at IS NULL
  )
);

-- There is deliberately **no** `counted_at <= recorded_at` constraint, tempting
-- as it looks. Business time is stated by a shop laptop whose clock is local and
-- occasionally fast, and both PR 4 and PR 5 decided that rejecting a business
-- timestamp for drifting a few minutes ahead blocks real work to enforce nothing
-- the ledger depends on. A CHECK here would go further than a rejection: it
-- would turn that drift into a constraint violation inside a transaction — a
-- `500` naming no field, for a count somebody really took.

-- The reconciliation movement must be a `COUNT_RECONCILIATION`, and it must be
-- on the shelf that was counted. Both are composite foreign keys against unique
-- keys that already exist — `inventory_movements_type_key` (0012) and
-- `inventory_movements_chain_key` (0005) — so neither costs a new index on the
-- ledger.
--
-- Between them and the `UNIQUE (reconciliation_movement_id)` above, every part
-- of the relationship is guaranteed by the database rather than by this
-- application's care: the movement exists, it is of the right type, it moved
-- stock on the counted variant at the counted location, and no second count can
-- claim it.
--
-- MATCH SIMPLE (the default) means neither is checked while the pointer is NULL,
-- which is every unresolved and every matched count.
ALTER TABLE inventory_count_lines
  ADD CONSTRAINT inventory_count_lines_movement_type_fk
  FOREIGN KEY (reconciliation_movement_id, reconciliation_movement_type)
  REFERENCES inventory_movements (id, movement_type)
  ON DELETE RESTRICT;

ALTER TABLE inventory_count_lines
  ADD CONSTRAINT inventory_count_lines_movement_same_shelf_fk
  FOREIGN KEY (reconciliation_movement_id, variant_id, location_id)
  REFERENCES inventory_movements (id, variant_id, location_id)
  ON DELETE RESTRICT;

-- Immutability --------------------------------------------------------------
--
-- The observation is evidence and is never edited. If somebody counted wrongly,
-- they count again and record a *new* observation — which leaves both the
-- mistaken count and the corrected one readable, and is the only honest way to
-- fix a fact about the past.
--
-- The reconciliation is a one-way decision. Once a discrepancy has been
-- accepted, the reason, the note, the person, the time and the movement are
-- fixed. If the *decision* was wrong, the remedy is to reverse its movement
-- (PR 5) and, if the shelf needs recounting, record a new count. The count keeps
-- saying what it always said: this was expected, this was seen, this was
-- accepted, and this movement resulted. Whether that movement was later reversed
-- is the ledger's business and the ledger already answers it.
--
-- Scoped to this one table and to these columns, like 0005's append-only
-- triggers. There is no generic immutability framework here, and a row-level
-- trigger that only ever compares columns is small enough to read in one sitting
-- — which is the test a trigger has to pass before it is worth having.
--
-- DELETE is not blocked. Nothing in the application deletes a count, and
-- `ON DELETE RESTRICT` on every foreign key *into* this row already stops the
-- rows it points at from going; a delete trigger here would be defending a table
-- nobody can reach with a statement nobody writes.

CREATE FUNCTION inventory_count_lines_reject_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id                 IS DISTINCT FROM OLD.id
  OR NEW.variant_id         IS DISTINCT FROM OLD.variant_id
  OR NEW.location_id        IS DISTINCT FROM OLD.location_id
  OR NEW.expected_quantity  IS DISTINCT FROM OLD.expected_quantity
  OR NEW.counted_quantity   IS DISTINCT FROM OLD.counted_quantity
  OR NEW.counted_by_user_id IS DISTINCT FROM OLD.counted_by_user_id
  OR NEW.counted_at         IS DISTINCT FROM OLD.counted_at
  OR NEW.recorded_at        IS DISTINCT FROM OLD.recorded_at
  OR NEW.operation_id       IS DISTINCT FROM OLD.operation_id
  THEN
    RAISE EXCEPTION
      'A physical count observation is immutable: what was counted, where, by whom, when, and what Ekon expected are permanent evidence. Record a new count instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION
      'This count has already been reconciled, and a reconciliation is a one-way decision. To undo its effect on stock, reverse movement %; to record a fresh observation, count again.',
      OLD.reconciliation_movement_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_count_lines_no_rewrite
  BEFORE UPDATE ON inventory_count_lines
  FOR EACH ROW
  EXECUTE FUNCTION inventory_count_lines_reject_rewrite();

-- Indexes -------------------------------------------------------------------
--
-- Three, and deliberately not more. Count volume for OR1 is a few observations
-- a week, so an index here is paid for by the query it serves and by nothing
-- else; the balance and history tables earned theirs by being read constantly.
--
-- The feed, and the cursor that pages it: `(recorded_at, id)`, ascending and
-- scanned backwards, for the same reason 0011 gives — PostgreSQL reads a btree
-- backwards just as cheaply, and a plain ascending index also serves a
-- chronological read if one is ever wanted.
CREATE INDEX inventory_count_lines_recorded_at_idx
  ON inventory_count_lines (recorded_at, id);

-- One shelf's count history, which is the second question anybody asks after
-- seeing a discrepancy, and the index the `variant_id` foreign key checks
-- against.
CREATE INDEX inventory_count_lines_shelf_idx
  ON inventory_count_lines (variant_id, location_id, recorded_at);

-- The location filter, and the `location_id` foreign key's own check.
CREATE INDEX inventory_count_lines_location_idx
  ON inventory_count_lines (location_id);

-- Deliberately **not** indexed:
--
--   * `status`. The discrepancy list is `status = 'OPEN'` and a partial index
--     on it is the obvious next addition — but at a few hundred rows the feed
--     index answers it by filtering, and an index added on a guess is one
--     nobody measures. It is a decision to take with a plan in hand.
--   * the two user columns. Nothing deletes a user (INV-16 says they are
--     deactivated), so the RESTRICT check is never run, and no read filters by
--     counter. A future user-deletion path would need one.
--   * the two operation columns, which already have unique indexes from their
--     UNIQUE constraints.

-- Every count reconciliation says why -----------------------------------------
--
-- `COUNT_RECONCILIATION` joins the movement types that require a `reason_code`
-- (INV-11). The reason is not the same question the other types answer: an
-- issue says why stock left, an adjustment says why the number was wrong, and a
-- reconciliation says **why the shop accepted that the shelf and the record
-- differ**. A variance of −1 accepted as an unrecorded sale and the same −1
-- accepted as shrinkage are identical arithmetic and opposite conclusions, and
-- one of them is the shop being told it is losing stock.
--
-- A reconciliation with no reason records that somebody moved stock to match a
-- count and would not say why, which is precisely the outcome the count
-- principle exists to prevent — so the database is where that is prevented,
-- rather than a check in a service somebody can forget to call.
--
-- **Safe on existing data, and not by assumption.** No route, service, or
-- workflow has ever posted a `COUNT_RECONCILIATION`: the posting engine has
-- always accepted the type, and until this PR nothing called it — receiving,
-- removal, adjustment and reversal each fix their own type. A deployed database
-- therefore holds none. Validated rather than `NOT VALID` for that reason: if
-- some environment does hold one, it is an unexplained stock change that
-- somebody needs to look at, and a migration that failed loudly is the right way
-- to find out. Widening the *type* vocabulary this way is 0008's technique; the
-- narrowing direction is the same one 0008 took for `ISSUE`.
--
-- Mirrors REASON_REQUIRED_MOVEMENT_TYPES in `shared/src/movements.ts`, and an
-- integration test compares the two.

ALTER TABLE inventory_movements
  DROP CONSTRAINT inventory_movements_reason_required;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_reason_required CHECK (
    movement_type NOT IN ('ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'COUNT_RECONCILIATION')
    OR reason_code IS NOT NULL
  );

COMMIT;
