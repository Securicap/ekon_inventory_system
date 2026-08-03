# 8. Haitian Creole is the primary employee-facing language

**Status:** Accepted — 2026-08-02

## Context

Employees are in Haiti. A user operating an append-only inventory ledger in a
second language makes more data-entry errors, and an error in an append-only
ledger is permanent — it requires a compensating movement to correct.

Retrofitting translation after screens exist is a mechanical refactor of every
component.

## Decision

Haitian Creole (`ht`) is the primary locale from the first screen. French (`fr`)
is available for the owner. Flat JSON message catalogues and a small typed
lookup — no i18n library.

CI fails on user-facing text hard-coded in JSX, and on a key present in one
catalogue but missing from the other.

All timestamps display in shop time (America/Port-au-Prince) for every user,
everywhere, so the owner abroad and the employee at the counter never read the
same movement as two different dates.

## Consequences

- Translation costs a `t()` call rather than a refactor.
- Two catalogues must be kept in step; CI enforces it.
- No dependency, no bundle cost, no framework to learn.
