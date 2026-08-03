# `inventory` module

**Owns:** `locations`, `inventory_movements`, `inventory_balances`,
`stock_counts`, `stock_count_lines`

**Responsibility:** the append-only ledger, the balance projection, and every
rule that protects them.

**This is the only module permitted to INSERT into `inventory_movements`.** That
is the boundary the whole system rests on.

Non-negotiable properties, all enforced by the database rather than by
convention:

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

Arrives in the ledger PR.
