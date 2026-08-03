# 4. Append-only movement ledger recording before and after quantities

**Status:** Accepted — 2026-08-02

## Context

The business must be able to answer, for any point in the past: what was the
quantity, who changed it, why, and what did it become. Inventory disputes are
resolved by history, so history that can be edited is worthless.

## Decision

`inventory_movements` is append-only. Every row records `quantity_delta`,
`quantity_before`, and `quantity_after`.

Enforced by the database, not by convention:

- `BEFORE UPDATE` and `BEFORE DELETE` triggers raise an exception.
- The application's database role is granted only `SELECT, INSERT`. Migrations
  run as a separate owner role.
- `CHECK (quantity_after = quantity_before + quantity_delta)`.
- `previous_movement_id UNIQUE`, plus a partial unique index allowing exactly
  one movement per `(variant, location)` with a null predecessor. Together these
  make the history a strict chain that cannot fork.
- The balance row is locked with `SELECT ... FOR UPDATE` inside the transaction,
  so two concurrent writers cannot both read the same starting quantity.

Corrections are compensating movements referencing the original. Physical counts
produce reconciliation movements; they never overwrite a quantity.

## Consequences

- `quantity_before` and `quantity_after` cannot be wrong, even under
  concurrency. Not "should not be" — cannot be.
- Every row is independently auditable without replaying history.
- The ledger becomes **order-dependent**, which a pure delta ledger is not. This
  is the price of before/after and it is worth paying, but it constrains the
  offline milestone: a queued client movement carries a delta only, and the
  server assigns its position in the chain at ingestion. Recorded in ADR 6.
- Writes to a single variant serialize. At this business's volume that is
  irrelevant; at a thousand movements per second it would not be.
