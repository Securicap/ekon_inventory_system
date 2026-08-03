# 5. PostgreSQL with hand-written SQL; no ORM

**Status:** Accepted — 2026-08-02

## Context

The schema is about fourteen tables. Its correctness rests on constraints,
triggers, partial unique indexes, and row locks — the parts of a database that
ORMs abstract away or model badly.

## Decision

PostgreSQL, accessed through `pg` with hand-written SQL in repository modules
and Zod parsers validating result rows. No ORM, no query builder.

Migrations are committed sequential `.sql` files applied by a small runner, each
in its own transaction, checksummed so an applied migration cannot be edited.

## Consequences

- The ledger's semantics are visible in code review, which is exactly where they
  need to be visible.
- No migration-generation magic, no lazy-loading surprises, no N+1 by accident.
- More typing for routine CRUD. Accepted: there is very little routine CRUD here
  and a great deal of invariant.
- Repository code must be tested against real PostgreSQL, never a stub.
