# Database invariants

Every invariant states what is guaranteed and **where it is enforced**. An
invariant enforced only in application code is a convention, not an invariant.

Items marked _(planned)_ have their enforcement designed but land with the
module that introduces the table.

## INV-1 — Posted movements are immutable

No row in `inventory_movements` is ever updated or deleted, by any code path.

_Enforcement (planned):_ `BEFORE UPDATE` and `BEFORE DELETE` triggers raising an
exception, **and** the application database role granted only `SELECT, INSERT`.
Migrations run as a separate owner role. A bug, a bad future migration, or a
leaked application credential cannot alter posted history.

_Enforced today:_ `scripts/check-conventions.mjs` fails the build on
`UPDATE inventory_movements` or `DELETE FROM inventory_movements` in source.

## INV-2 — Corrections are compensating movements

A mistake is corrected by inserting a `REVERSAL` with
`quantity_delta = -original.quantity_delta` and `reverses_movement_id` set, then
a fresh correct movement if needed.

_Enforcement (planned):_ `UNIQUE (reverses_movement_id)` prevents double
reversal. The delta is computed server-side from the original row inside the
transaction and is never supplied by the client. A `REVERSAL` cannot itself be
reversed.

## INV-3 — Before and after quantities are arithmetically consistent

_Enforcement (planned):_ `CHECK (quantity_after = quantity_before + quantity_delta)`.

## INV-4 — Movement history cannot fork

For each `(variant, location)`, movements form a strict chain.

_Enforcement (planned):_ `previous_movement_id uuid UNIQUE`, plus
`CREATE UNIQUE INDEX ... ON inventory_movements (variant_id, location_id) WHERE previous_movement_id IS NULL`.
Two concurrent transactions claiming the same predecessor collide at the
database; the second fails rather than producing two rows that both claim the
same starting quantity.

## INV-5 — Stock changes are atomic

The movement insert, the balance update, the `operations` row, and any audit
event commit in one transaction, or none of them do.

_Enforcement:_ a single `withTransaction` unit of work per command, with
`SELECT ... FOR UPDATE` on the balance row.

## INV-6 — The projection always equals the ledger

For every `(variant, location)`: `quantity_on_hand = SUM(quantity_delta)`.

_Enforcement:_ INV-5 guarantees it at write time. Verified by
`verify-balances`, run on a schedule, and by a property test over generated
movement sequences. Recovery is `rebuild-balances`, which recomputes the
projection from the ledger — always safe, because the ledger is immutable.

## INV-7 — Every command applies at most once

_Enforcement (planned):_ `operations.id` primary key, written with
`INSERT ... ON CONFLICT (id) DO NOTHING RETURNING *`. No row returned means
replay: load it, compare `request_hash`, and either return the stored result or
fail with `409` if the body differs. Never check-then-insert, which races.

_Client obligation:_ the operation id is generated when the form opens and
reused for every retry, including after a reload. Enforced by
`frontend/src/lib/operations.ts` and its tests.

## INV-8 — Stock never goes below zero

For any role, by any path.

_Enforcement (planned):_ `CHECK (quantity_on_hand >= 0)` on the balance and
`CHECK (quantity_before >= 0)`, `CHECK (quantity_after >= 0)` on the movement.

_Rationale:_ a shelf cannot hold minus three items. Systems that permit negative
stock are accommodating out-of-order paperwork, and there is always a correct
alternative: record the missing receipt first, or run a physical count —
`counted_quantity` is what is actually there, which is never negative. There is
deliberately no capability that grants an override.

## INV-9 — Physical counts reconcile, never overwrite

A count line produces a `COUNT_RECONCILIATION` movement of
`counted_quantity - expected_quantity`. `expected_quantity` is snapshotted when
the line is entered, so the recorded discrepancy is what the counter actually
saw. A zero delta records the line and creates no movement.

## INV-10 — Quantities are integers in whole base units

Never floating point.

_Enforcement:_ `integer` columns, and `scripts/check-conventions.mjs` rejects
`real`, `double precision`, `float4`, `float8`, and `money` in any migration.

## INV-11 — Every movement is fully attributable

`user_id`, `device_id`, `operation_id`, `occurred_at`, `recorded_at` are all
`NOT NULL`. `reason_code` is required for adjustments.

_Enforcement (planned):_ `NOT NULL` constraints plus
`CHECK (movement_type NOT IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT') OR reason_code IS NOT NULL)`.

## INV-12 — Rows with history are deactivated, never deleted

_Enforcement (planned):_ `ON DELETE RESTRICT` on foreign keys from
`inventory_movements`. No delete endpoint exists.

## INV-13 — SKUs are unique and immutable

_Enforcement (planned):_ `UNIQUE (sku)`, plus a trigger rejecting any update
that changes it. SKUs are printed on physical shelf labels; changing the format
after labels exist is a physical-world migration.
