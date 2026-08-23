-- 0012_lifecycle_authority_and_reversal_integrity.sql
--
-- Two things, and they are the two halves of what PR 5 needed the database to
-- say:
--
--   * `lifecycle_status` becomes the **only** authority on merchandise
--     availability. The `is_active` bridge 0009 opened is reconciled and then
--     removed from `products` and `product_variants`.
--   * A `REVERSAL` is constrained to be a genuine correction: of a movement on
--     its own chain, and never of another reversal. Both rules were previously
--     left to the posting workflow, and both turn out to be expressible as
--     ordinary foreign keys.
--
-- What this migration does NOT do, and it is worth stating because the whole
-- PR rests on it:
--
--   * It rewrites no movement. `inventory_movements` gains a column and gains
--     constraints; not one existing row's id, type, quantity, chain position,
--     reason, actor, or timestamp is touched. The append-only triggers (0005)
--     remain, and `ALTER TABLE ... ADD COLUMN` does not fire them because it
--     is not an UPDATE of a row.
--   * It rebuilds no balance. `inventory_balances` is not named anywhere below.
--   * It re-keys nothing. Every product id, variant id, SKU, variant signature,
--     operation id, and movement id is exactly what it was.
--   * It deletes nothing.
--
-- Conventions from 0001 apply: text + CHECK instead of native enums, no
-- database-generated ids, and additive changes wherever an existing row could
-- otherwise be disturbed.

BEGIN;

-- Lifecycle becomes the authority --------------------------------------------
--
-- 0009 added `lifecycle_status` to both tables and left `is_active` in charge,
-- deliberately: making lifecycle authoritative in the migration that introduced
-- it would have changed what may be stocked underneath an application with no
-- way to set it. PR 5 builds that workflow, so the bridge closes here. Two
-- flags for adjacent notions is what INV-16 warns against, and the accepted
-- cost was always temporary.
--
-- THE BACKFILL, and the one judgement call in this file.
--
-- `is_active = false` means "withdrawn" and nothing more precise. It cannot
-- distinguish the two lifecycle states that a withdrawal might have meant:
--
--   DISCONTINUED  no longer replenished; existing stock is still sold, still
--                 counted, and still visible on the current-stock screen.
--   ARCHIVED      out of day-to-day operation entirely, and — as of PR 5 — a
--                 state that asserts the merchandise holds no stock at all.
--
-- So it is not guessed at. `DISCONTINUED` is chosen because it is the
-- conservative answer in the exact sense that matters: it preserves everything
-- the old flag actually asserted (this is not replenished) while asserting
-- nothing the old flag could not know. Choosing `ARCHIVED` would claim a
-- zero-stock guarantee about rows nobody has looked at, and if any of them
-- still hold units the system would be hiding real inventory behind an
-- invariant it had already broken on the way in. Under `DISCONTINUED` those
-- units stay visible, sellable and countable, and somebody who wants the row
-- archived archives it — through the workflow, which checks the stock first.
--
-- Rows that were already `is_active = true` are already `ACTIVE` and are not
-- touched. A row whose `lifecycle_status` is not `ACTIVE` is not touched
-- either: it was set deliberately, and this statement must not overwrite a
-- decision with a default. In practice no such row can exist yet — nothing
-- could set the column before this PR — but the guard costs nothing and states
-- the rule for anyone reading it later.

UPDATE products
   SET lifecycle_status = 'DISCONTINUED',
       updated_at       = updated_at
 WHERE is_active = false
   AND lifecycle_status = 'ACTIVE';

UPDATE product_variants
   SET lifecycle_status = 'DISCONTINUED',
       updated_at       = updated_at
 WHERE is_active = false
   AND lifecycle_status = 'ACTIVE';

-- `updated_at` is deliberately assigned to itself above rather than moved to a
-- migration timestamp. The lifecycle of this merchandise did not change today —
-- what changed is which column records it — and stamping every withdrawn row
-- with the deploy date would erase when the shop actually withdrew it.

-- The columns go. Nothing in the application reads or writes either one any
-- more: `findStockableVariant` and `listStockableVariants` have been replaced
-- by lifecycle-aware questions, the catalog's product loader selects
-- `lifecycle_status` alone, and `isActive` is off the public product and
-- variant contracts. Dropping rather than leaving them is the point of the
-- exercise — a column nothing reads is a column somebody will start reading
-- again, and then there are two authorities that disagree.
--
-- `users.is_active` and `inventory_locations.is_active` are untouched and stay.
-- They are different facts about different things: whether a person may sign in
-- (INV-16) and whether a shelf is open for business (0004). Neither is
-- merchandise lifecycle, and neither has a lifecycle column to be reconciled
-- with.

ALTER TABLE products         DROP COLUMN is_active;
ALTER TABLE product_variants DROP COLUMN is_active;

-- Reversal integrity ---------------------------------------------------------
--
-- 0005 already constrains the shape of a reversal row-locally: a `REVERSAL`
-- names a movement, nothing else may name one, nothing may name itself, and
-- `UNIQUE (reverses_movement_id)` means one movement is reversed at most once.
-- Two rules were left out because a row cannot check them by looking at itself:
--
--   1. the reversal must belong to the same chain as its original;
--   2. a `REVERSAL` may not itself be reversed.
--
-- Both are stated in the module README as workflow responsibilities. Both are
-- in fact expressible as foreign keys, and a foreign key holds against a bug in
-- the workflow, a future workflow that forgets, and a hand-written statement in
-- a support session. That is the difference between an invariant and a
-- convention.
--
-- Rule 1 costs nothing at all: `inventory_movements_chain_key` — the
-- `UNIQUE (id, variant_id, location_id)` that 0005 added so a movement's
-- predecessor could be pinned to its own chain — is exactly the key this needs.
-- The reversal already stores its own `variant_id` and `location_id`, so the
-- composite key asserts that the movement it names carries the same pair.
--
-- MATCH SIMPLE (the default) means the constraint is skipped when
-- `reverses_movement_id` is NULL, which is every non-reversal movement in the
-- ledger.

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_reverses_same_chain_fk
  FOREIGN KEY (reverses_movement_id, variant_id, location_id)
  REFERENCES inventory_movements (id, variant_id, location_id)
  ON DELETE RESTRICT;

-- Rule 2 needs the *type* of the movement being reversed, and a row cannot see
-- another row's columns. So the type is stored alongside the pointer and then
-- constrained — the technique 0009 used for `product_classifications`, where a
-- denormalized `dimension_id` exists to be constrained rather than to be
-- trusted. The value is not application data and no read exposes it; it is a
-- constraint's working column.
--
-- Three constraints make it airtight:
--
--   * the pair is complete — a pointer without a type, or a type without a
--     pointer, would let the foreign key be skipped by leaving one NULL. The
--     same shape as `operations_result_pointer_complete` (0005);
--   * the recorded type is not `REVERSAL`, which is the rule itself;
--   * the foreign key proves the recorded type is the named movement's actual
--     type, so the first two cannot be satisfied with a convenient lie.
--
-- The type column is `text` with no vocabulary CHECK of its own: the foreign
-- key already restricts it to a type some real movement carries, and a second
-- list here would be a third place for the vocabulary to drift.

ALTER TABLE inventory_movements
  ADD COLUMN reverses_movement_type text;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_reverses_pointer_complete CHECK (
    (reverses_movement_id IS NULL) = (reverses_movement_type IS NULL)
  ),
  ADD CONSTRAINT inventory_movements_reverses_not_a_reversal CHECK (
    reverses_movement_type IS NULL OR reverses_movement_type <> 'REVERSAL'
  );

-- The unique key the foreign key below references. Redundant with the primary
-- key on its own — `id` is already unique, so `(id, movement_type)` cannot be
-- anything else — but a foreign key needs a unique constraint on exactly the
-- columns it references, and 0005 added `inventory_movements_chain_key` for
-- precisely the same reason.
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_type_key UNIQUE (id, movement_type);

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_reverses_type_fk
  FOREIGN KEY (reverses_movement_id, reverses_movement_type)
  REFERENCES inventory_movements (id, movement_type)
  ON DELETE RESTRICT;

-- Every constraint added here is validated against the existing ledger as it is
-- created, inside this transaction, and none of them can fail on data that is
-- already stored: no row in any environment carries `movement_type = 'REVERSAL'`
-- or a non-NULL `reverses_movement_id`, because the posting engine refused to
-- write one until this PR. Deliberately not `NOT VALID` — there is no large
-- scan to defer, and a ledger that accepted unchecked reversals for the length
-- of a deploy is the one thing this file exists to prevent. 0010's `NOT VALID`
-- key was a different case entirely: there the existing rows were genuinely
-- unverifiable and had to stay.

COMMIT;
