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
  **No stock-posting workflow is exposed yet** — no service, no repository, no
  endpoint reads or writes these tables, and nothing inserts a movement. The
  schema exists so the posting engine can be built against invariants that
  already hold.

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

The posting engine itself (the internal service that inserts a movement and
updates its balance in one transaction), receiving, adjustments, physical
counts, public reversal, the balance API, transfers, multi-location stock
behaviour, and location management (create / rename / deactivate). Offline sync
remains deferred too. No frontend behaviour changes with this schema.

Two rules the schema deliberately leaves to that engine, because they need a
lookup rather than a row-local check: a `REVERSAL` must belong to the same chain
as the movement it reverses, and `quantity_delta` must have the sign its
movement type implies.

## Invariants that remain the module's own

- **This is the only module permitted to INSERT into `inventory_movements`.**
  That is the boundary the whole system rests on, and it is enforced by review
  and by `scripts/check-conventions.mjs`, not by the schema.
- The balance row is updated in the same transaction as the movement insert,
  under `SELECT ... FOR UPDATE` (INV-5).
- Physical counts produce reconciliation movements and never overwrite a
  quantity (INV-9).
