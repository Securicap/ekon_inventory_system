# 6. Client-generatable UUIDv7 identifiers and offline-ready metadata

**Status:** Accepted — 2026-08-02

## Context

The first release is online-only, but offline operation is the next milestone.
Metadata that is not captured at the moment an event happens cannot be recovered
later.

## Decision

All primary keys are UUIDv7, generated in application code — never by the
database — so generation can move to the browser without a schema change. They
are time-ordered, so index inserts stay sequential and ids sort chronologically.

Captured from the first release, even though nothing consumes them yet:

- `device_id` on every movement and audit event
- `operation_id` on every state-changing command, generated when a form opens
  and reused across retries and reloads
- `client_recorded_at` and `client_seq`, nullable, for a future queue
- `occurred_at` (business time) distinct from `recorded_at` (server time)

Explicitly **not** built now: durable client queue, service worker, CRDTs,
vector clocks, multi-device merge, conflict resolution.

## Consequences

- The offline milestone is additive: new client code, no schema rewrite, no
  backfill.
- A few unused columns exist today. That is much cheaper than the alternative.
- Constraint the offline milestone must respect: `quantity_before`,
  `quantity_after`, and `previous_movement_id` are assigned by the server at
  ingestion, never by the client. A queued movement carries a delta, not a
  position in the chain. See ADR 4.
