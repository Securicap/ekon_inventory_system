# `inventory` module

**Owns:** `inventory_locations`, `inventory_movements`, `inventory_balances`,
and later `stock_counts`, `stock_count_lines`.

**Responsibility:** the places stock can sit, the append-only movement history,
the balance projection, and every rule that protects them.

## Currently provides

- The `inventory_locations` table — a place stock can sit. Locations deactivate
  rather than delete once they carry history; a partial unique index allows **at
  most one** default location.
- Exactly **one seeded default location** for a fresh install: `Main Store`,
  default and active. Application code discovers the default from the database
  when it needs it — the seeded id is never hard-coded outside the migration.
- `GET /api/inventory/locations` — lists all locations, active and inactive,
  default first (`ORDER BY is_default DESC, created_at, id`), as a plain array.
  Declares the `inventory.read` capability (enforcement arrives with identity).
- **The ledger tables and their invariants** (migration
  `0005_inventory_ledger_core.sql`): `operations`, `inventory_movements`, and
  `inventory_balances`, with every rule below enforced by the database.
- **The internal posting engine** (`ledgerService.ts`,
  `infrastructure/ledgerRepository.ts`) — one trusted operation,
  `postMovement`, that appends a single normal movement and moves its balance.
  **It has no HTTP surface:** no route, no request schema, no handler, and
  nothing outside this module calls it yet. It is not receiving, not
  adjustments, and not counts — those workflows are thin callers that arrive in
  their own PRs.

## The posting engine

`postMovement(command)` runs one transaction and commits all of it or none of
it (INV-5):

1. Claims the operation id with
   `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`. Never check-then-insert,
   which races (INV-7).
2. Locks the `(variant_id, location_id)` balance with `SELECT ... FOR UPDATE`,
   creating the zero row first if that shelf has never held stock.
3. Derives `quantity_before` from the locked balance, `quantity_after` from the
   delta, and `previous_movement_id` from `last_movement_id`. **Stock is never
   calculated by summing the ledger**, and the caller never supplies before,
   after, or predecessor values.
4. Appends one movement, with `reverses_movement_id` always NULL.
5. Updates the balance projection to the new quantity and last movement.
6. Records `result_resource_type = 'inventory_movement'` and the movement id on
   the operation — the pointer only, never the request or response body.

**Retries.** A repeated operation id whose `operation_type` and `request_hash`
both match returns the movement the first attempt posted, and posts nothing.
A mismatch on either is `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` (409). A
matching operation that records no usable movement result is an `INTERNAL`
failure, never a second movement.

**Rules applied before the transaction opens.** The movement type must be in the
shared vocabulary; `RECEIPT` and `ADJUSTMENT_IN` require a positive delta,
`ADJUSTMENT_OUT` a negative one, `COUNT_RECONCILIATION` either; zero and
fractional deltas are refused; adjustments require a non-blank reason code. A
movement that would drive stock below zero is refused inside the transaction
with `INSUFFICIENT_STOCK` (422) — and the database CHECKs remain the final
protection.

**`REVERSAL` is refused** with a clear "not implemented" error. It derives its
delta from the movement it reverses and must set `reverses_movement_id`, which
is a different command shape; it lands with the reversal workflow.

## Ledger schema (enforced today, in the database)

- **Append-only.** `BEFORE UPDATE`, `BEFORE DELETE`, and `BEFORE TRUNCATE`
  triggers on `inventory_movements` raise `restrict_violation` with a message
  saying posted movements are immutable and corrections are compensating
  movements. Granting the application role only `SELECT, INSERT` is added with
  identity, when database roles exist (INV-1).
- **Self-consistent rows.** `quantity_delta <> 0`,
  `quantity_before >= 0`, `quantity_after >= 0`, and
  `quantity_after = quantity_before + quantity_delta` (INV-3, INV-8).
- **A closed vocabulary.** `movement_type` is `text` + `CHECK` over exactly the
  five values in `shared/src/movements.ts`. An integration test compares the two
  sets, so the database and the wire format cannot drift.
- **A strict chain per (variant, location).** `previous_movement_id` is `UNIQUE`
  (one successor per movement); a partial unique index allows one opening
  movement per chain; a composite foreign key
  `(previous_movement_id, variant_id, location_id) → (id, variant_id, location_id)`
  forces the predecessor to belong to the same chain; and a movement cannot name
  itself as its predecessor. Two concurrent writers claiming the same
  predecessor collide at the database (INV-4).
- **Reversal shape.** A `REVERSAL` must name the movement it reverses; nothing
  else may name one; nothing reverses itself; and `UNIQUE (reverses_movement_id)`
  means one movement is reversed at most once (INV-2).
- **Attribution.** `operation_id`, `user_id`, `device_id`, `occurred_at`, and
  `recorded_at` are `NOT NULL`, and adjustments require a `reason_code`
  (INV-11). `user_id` deliberately carries **no** foreign key until identity
  exists — a key pointing at a fiction is worse than none.
- **Balances are a checked projection.** `PRIMARY KEY (variant_id, location_id)`,
  `quantity_on_hand >= 0`, a nonzero balance must name a last movement, and that
  pointer is a composite foreign key into the balance's own chain, so a balance
  can never summarize someone else's history (INV-6, INV-8).
- **Idempotency.** `operations` is narrow on purpose: an id, a type, a request
  hash, and an optional result pointer. No status, attempts, payloads, errors, or
  workflow state — that would make it a job queue (INV-7).
- **Nothing is deleted.** Every foreign key from the ledger onto catalog,
  locations, and operations is `ON DELETE RESTRICT` (INV-12). No balance rows are
  seeded: an absent row means zero.

## Deferred (future PRs)

Receiving, adjustments, physical counts, public reversal, the balance API, and
every HTTP route that would reach the posting engine. Reversal posting itself.
Concurrency hardening — the engine takes the row lock, but concurrent-writer
stress testing and the behaviour under contention are a separate PR. Transfers,
multi-location stock behaviour, and location management (create / rename /
deactivate). Offline sync remains deferred too. No frontend behaviour changes
with this work.

One rule the schema leaves to the reversal workflow because it needs a lookup
rather than a row-local check: a `REVERSAL` must belong to the same chain as the
movement it reverses.

## Invariants that remain the module's own

- **This is the only module permitted to INSERT into `inventory_movements`.**
  That is the boundary the whole system rests on, and it is enforced by review
  and by `scripts/check-conventions.mjs`, not by the schema. In practice it now
  means: through `postMovement`, and nowhere else.
- Physical counts produce reconciliation movements and never overwrite a
  quantity (INV-9). The engine can post a `COUNT_RECONCILIATION` in either
  direction; the count workflow that decides the delta is deferred.
