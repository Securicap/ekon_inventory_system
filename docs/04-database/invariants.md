# Database invariants

Every invariant states what is guaranteed and **where it is enforced**. An
invariant enforced only in application code is a convention, not an invariant.

Items marked _(planned)_ have their enforcement designed but land with the
module that introduces the table.

## INV-1 — Posted movements are immutable

No row in `inventory_movements` is ever updated or deleted, by any code path.

_Enforcement:_ `BEFORE UPDATE`, `BEFORE DELETE`, and `BEFORE TRUNCATE` triggers
on `inventory_movements` raising `restrict_violation` (0005).
`scripts/check-conventions.mjs` also fails the build on
`UPDATE inventory_movements` or `DELETE FROM inventory_movements` in source.

_Planned:_ the application database role granted only `SELECT, INSERT`, with
migrations run as a separate owner role. That lands with identity, when roles
exist. A bug, a bad future migration, or a leaked application credential must
not be able to alter posted history.

## INV-2 — Corrections are compensating movements

A mistake is corrected by inserting a `REVERSAL` with
`quantity_delta = -original.quantity_delta` and `reverses_movement_id` set, then
a fresh correct movement if needed.

_Enforcement:_ `UNIQUE (reverses_movement_id)` prevents double reversal (0005),
together with CHECKs requiring a `REVERSAL` to name its original, forbidding any
other type from naming one, and forbidding a movement from reversing itself.

_Planned:_ the delta is computed server-side from the original row inside the
transaction and is never supplied by the client. A `REVERSAL` cannot itself be
reversed, and it must belong to the same chain as its original — both are
lookups, so they belong to the posting engine.

## INV-3 — Before and after quantities are arithmetically consistent

_Enforcement:_ `CHECK (quantity_after = quantity_before + quantity_delta)`, plus
`CHECK (quantity_delta <> 0)` (0005).

## INV-4 — Movement history cannot fork

For each `(variant, location)`, movements form a strict chain.

_Enforcement:_ `previous_movement_id uuid UNIQUE`, plus
`CREATE UNIQUE INDEX ... ON inventory_movements (variant_id, location_id) WHERE previous_movement_id IS NULL`
(0005). Two concurrent transactions claiming the same predecessor collide at the
database; the second fails rather than producing two rows that both claim the
same starting quantity.

The predecessor must also be on the same chain, which a self-referencing
composite foreign key
`(previous_movement_id, variant_id, location_id) → (id, variant_id, location_id)`
guarantees, and a movement cannot name itself as its predecessor. The same
composite key shape points `inventory_balances.last_movement_id` at its own
chain.

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

_Enforcement:_ the `operations.id` primary key exists (0005). _Planned:_ the
write itself, `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING *`, arrives with
the posting engine. No row returned means
replay: load it, compare `request_hash`, and either return the stored result or
fail with `409` if the body differs. Never check-then-insert, which races.

_Client obligation:_ the operation id is generated when the form opens and
reused for every retry, including after a reload. Enforced by
`frontend/src/lib/operations.ts` and its tests.

## INV-8 — Stock never goes below zero

For any role, by any path.

_Enforcement:_ `CHECK (quantity_on_hand >= 0)` on the balance and
`CHECK (quantity_before >= 0)`, `CHECK (quantity_after >= 0)` on the movement
(0005).

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

_Enforcement:_ `NOT NULL` constraints plus
`CHECK (movement_type NOT IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT') OR reason_code IS NOT NULL)`
(0005). `user_id` is `NOT NULL` but carries no foreign key until identity
exists; a key pointing at a placeholder actor would be worse than none.

## INV-12 — Rows with history are deactivated, never deleted

_Enforcement:_ `ON DELETE RESTRICT` on every foreign key from
`inventory_movements` and `inventory_balances` onto catalog rows, locations, and
operations (0005). No delete endpoint exists.

## INV-13 — SKUs are unique and immutable

_Enforcement (planned):_ `UNIQUE (sku)`, plus a trigger rejecting any update
that changes it. SKUs are printed on physical shelf labels; changing the format
after labels exist is a physical-world migration.
