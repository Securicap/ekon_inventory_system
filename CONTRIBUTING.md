# Contributing

This repository is meant to stay readable by a developer who has never seen it.
If something here is confusing, that is a bug in the documentation.

## Before you start

Run `make setup`, then `make check`. If both pass, your environment is correct.

## Branches and pull requests

- Branch from `main`: `feature/short-description`, `fix/short-description`.
- One pull request does one thing. Aim for 200–600 changed lines excluding
  lockfiles. A PR that is too big to review carefully will not be reviewed
  carefully.
- The PR template has a checklist. The inventory section applies whenever you
  touch the ledger.
- `make check` must pass before you open the PR.

## Commit messages

```
<area>: <what changed>

<why, if it is not obvious>
```

Areas: `backend`, `frontend`, `shared`, `db`, `ci`, `docs`, `infra`.

## Adding a dependency

Every dependency is support burden for a very small team. In the PR, say what
problem it solves **today** — not one we might have later. Prefer 30 lines of
our own code over a package that does 30 things when we need one.

Rejected on principle unless the reasoning is exceptional: an ORM, a state
management library, an i18n framework, a component library, a message broker.

## Migrations

- Name them `NNNN_lower_snake_case.sql`, numbered sequentially.
- **Never edit a migration that has been merged.** It has already run somewhere.
  The runner checksums applied migrations and will refuse to start. Write a new
  forward migration instead.
- There is no `down`. Reversing a schema change in production is a new forward
  migration, which is reviewable and leaves a record.
- Migrations are additive wherever possible. Dropping a column that holds
  inventory history is a data-loss event.

## Working on the inventory module

This is where care matters most.

- `inventory_movements` may only be `INSERT`ed into and `SELECT`ed from.
- `quantity_before`, `quantity_after`, and `previous_movement_id` are computed
  by the server inside the transaction, holding a row lock on the balance. They
  are never accepted from a client.
- The movement insert, the balance update, the `operations` row, and any audit
  event commit in **one** transaction.
- Every state-changing route goes through the operation-id idempotency wrapper.
- A correction is a compensating movement. There is no edit path and there
  should never be one.

If a change seems to need an exception to any of these, that is worth a
conversation before writing the code.

## Testing

- Integration tests run against **real PostgreSQL**. The integrity model lives
  in database constraints; testing it against a stub proves nothing.
- Test the failure cases, not only the happy path. The failure cases are the
  reason the constraints exist.
- Inventory arithmetic gets property-based tests, not only examples.

## User-facing text

No string that a shop employee will read may be hard-coded. Add the key to both
`frontend/src/i18n/ht.json` and `fr.json`. CI checks this. Haitian Creole is the
primary language; French is for the owner.
