## What this changes

<!-- One or two sentences. What can the business do after this that it could not before? -->

## Why

<!-- Link the milestone item or the decision record this implements. -->

## Checklist

- [ ] Tests cover the new behaviour, including its failure cases
- [ ] No new dependency, or the PR explains what problem it solves that we have today
- [ ] Migrations are additive and reviewed; no previously merged migration was edited
- [ ] No user-facing string is hard-coded — both locale files updated
- [ ] `make check` passes locally

## If this touches inventory

- [ ] `inventory_movements` is still only INSERTed into and SELECTed from
- [ ] Movement insert, balance update, operation row, and audit event commit in one transaction
- [ ] `quantity_before` / `quantity_after` are computed server-side, never accepted from the client
- [ ] The operation-id idempotency wrapper is used on every state-changing route
- [ ] Corrections are compensating movements, not edits
