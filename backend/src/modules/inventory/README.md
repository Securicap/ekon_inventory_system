# `inventory` module

**Owns:** `inventory_locations`, and later `inventory_movements`,
`inventory_balances`, `stock_counts`, `stock_count_lines`.

**Responsibility:** the places stock can sit, and — once the ledger lands — the
append-only movement history, the balance projection, and every rule that
protects them.

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

## Deferred (future PRs)

Movements, balances, receiving, adjustments, physical counts, transfers,
multi-location stock behaviour, and location management (create / rename /
deactivate). Offline sync remains deferred too.

## Future ledger invariants (not yet implemented)

When the movement ledger arrives it will hold these non-negotiable properties,
all enforced by the database rather than by convention:

- **This is the only module permitted to INSERT into `inventory_movements`.**
  That is the boundary the whole system rests on.
- Posted movements are never updated or deleted. BEFORE UPDATE and BEFORE DELETE
  triggers raise, and the application role is granted only SELECT and INSERT.
- Each movement records `quantity_before` and `quantity_after`, with a CHECK
  that `quantity_after = quantity_before + quantity_delta`.
- Movements for a given (variant, location) form a strict chain via
  `previous_movement_id UNIQUE`, plus a partial unique index allowing exactly
  one opening movement. Two concurrent writers cannot both claim the same
  predecessor, so before/after values cannot be wrong under concurrency.
- The balance row is updated in the same transaction as the movement insert,
  under `SELECT ... FOR UPDATE`.
- Stock can never go below zero, by any path, for any role.
- Corrections are compensating movements; physical counts produce reconciliation
  movements and never overwrite a quantity.
- Movement foreign keys onto locations use `ON DELETE RESTRICT`.
