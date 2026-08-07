-- 0008_inventory_stock_removal.sql
--
-- Ordinary stock leaving inventory. Two closed vocabularies grow, and nothing
-- else changes:
--
--   * `inventory_movements.movement_type` gains `ISSUE` — stock legitimately
--     left the location through ordinary operations, and said why.
--   * `role_capabilities.capability` gains `inventory.remove`, granted to all
--     four roles.
--
-- No table is created, no column is added, and no row is rewritten. Both
-- vocabularies live in CHECK constraints (0001's convention: text + CHECK, not
-- native enums), so widening one means replacing its constraint — which is an
-- additive change to what the column accepts, not a change to what it holds.
--
-- `ISSUE` is a new type rather than a reuse of `ADJUSTMENT_OUT`, and that
-- decision is permanent. An issue says stock genuinely left: sold, broken,
-- consumed. An adjustment says the recorded balance was wrong and somebody
-- corrected it downward — the stock had already gone, or had never been there.
-- The two look identical in a balance and mean opposite things in a history:
-- one is trade, the other is a recording error. Every movement written under
-- the wrong one of them is wrong forever, because this ledger is append-only
-- and a compensating movement cannot un-say what the original claimed. So the
-- distinction is made in the vocabulary, where it cannot be got wrong by
-- choosing a reason carelessly.
--
-- The type is `ISSUE` and not `SALE`, `ORDER`, `SHIPMENT`, or `RETURN`: those
-- name business domains this system does not have, and a ledger column that
-- referred to one would be a claim about a module nobody has designed. Stock
-- leaving is the fact; whether it was sold is the *reason*, and the reason
-- vocabulary is the application's (`REMOVAL_REASONS` in `@ekon/shared`) rather
-- than the database's, so it can grow without a migration.

BEGIN;

-- Movement vocabulary ------------------------------------------------------
--
-- Replacing a CHECK is the additive technique here: the column is `text`, so no
-- type changes, no rewrite happens, and no existing row is touched. The new
-- constraint is strictly wider than the old one — every value the old one
-- accepted, the new one accepts — so the validation scan cannot fail, and it
-- runs inside this transaction with no window in which the table is
-- unconstrained.
--
-- Deliberately not `NOT VALID` + `VALIDATE CONSTRAINT`: that pattern exists to
-- avoid a long exclusive lock while scanning a large table, and it would leave
-- the ledger accepting an unchecked value for the length of a deploy. This is
-- one shop's inventory, the scan is trivial, and a movement type is exactly the
-- thing that must never be writable outside the vocabulary.
--
-- Kept identical to MOVEMENT_TYPES in `shared/src/movements.ts`. A test asserts
-- the two sets are equal, so the database and the wire format cannot drift.

ALTER TABLE inventory_movements
  DROP CONSTRAINT inventory_movements_type_known;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_type_known CHECK (
    movement_type IN (
      'RECEIPT',
      'ISSUE',
      'ADJUSTMENT_IN',
      'ADJUSTMENT_OUT',
      'COUNT_RECONCILIATION',
      'REVERSAL'
    )
  );

-- Every issue says why ------------------------------------------------------
--
-- `ISSUE` joins the adjustment types in requiring a `reason_code` (INV-11), and
-- the constraint is renamed to say what it now covers: it is no longer about
-- adjustments. `inventory_movements_adjustment_requires_reason` becomes
-- `inventory_movements_reason_required`.
--
-- An adjustment needs a reason because the number changed without the stock
-- moving, so the reason is the only account of what happened. An issue needs
-- one for a different reason that lands in the same place: the stock really
-- moved, but "it left" is not yet a fact anybody can act on. Sold, broken, and
-- taken for the shop's own use are three different things, and a business that
-- cannot tell them apart cannot tell trade from loss. The type without the
-- reason is half a record.
--
-- This is the one constraint here that is *narrower* than what it replaces. It
-- is safe on existing data for a structural reason rather than an optimistic
-- one: `ISSUE` was not in the vocabulary until eight lines ago, so no row can
-- carry it. Nothing is loosened for the adjustment types, which are still
-- covered exactly as they were.
--
-- Mirrors REASON_REQUIRED_MOVEMENT_TYPES in `shared/src/movements.ts`.

ALTER TABLE inventory_movements
  DROP CONSTRAINT inventory_movements_adjustment_requires_reason;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_reason_required CHECK (
    movement_type NOT IN ('ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT')
    OR reason_code IS NOT NULL
  );

-- Capability vocabulary ----------------------------------------------------
--
-- `inventory.remove` is its own capability and not a reuse of
-- `inventory.adjust`, for the same reason `ISSUE` is its own movement type.
-- Recording that stock left is what an employee does all day; correcting a
-- balance that was wrong is an authority over the records themselves. Gating
-- routine removal behind the adjustment capability would have handed every
-- employee the power to make a shortfall disappear, in order to let them
-- record a sale.
--
-- Identical to CAPABILITIES in `shared/src/capabilities.ts`.

ALTER TABLE role_capabilities
  DROP CONSTRAINT role_capabilities_capability_known;

ALTER TABLE role_capabilities
  ADD CONSTRAINT role_capabilities_capability_known CHECK (
    capability IN (
      'catalog.read',
      'catalog.write',
      'catalog.deactivate',
      'inventory.read',
      'inventory.receive',
      'inventory.remove',
      'inventory.adjust',
      'inventory.count',
      'inventory.reverse',
      'audit.read',
      'identity.manage',
      'reports.export'
    )
  );

-- The grants. Written out explicitly, exactly as 0007 wrote its seed, so the
-- whole authorization model stays readable rather than generated. A test
-- compares these rows against DEFAULT_ROLE_CAPABILITIES in `@ekon/shared` and
-- fails if either side gains or loses a single grant.
--
-- All four roles, including `EMPLOYEE`. Stock leaves the shelf whether or not
-- the system lets the person at the counter say so; an operating model that
-- made them fetch a manager to record a sale would be one nobody used, and the
-- ledger would be the only thing that did not know what the shop had.
--
-- No existing grant is touched, and nothing is revoked.

INSERT INTO role_capabilities (role, capability) VALUES
  ('SUPER_ADMIN', 'inventory.remove'),
  ('OWNER',       'inventory.remove'),
  ('MANAGER',     'inventory.remove'),
  ('EMPLOYEE',    'inventory.remove');

COMMIT;
