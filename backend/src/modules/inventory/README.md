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
  Requires the `inventory.read` capability, declared in the route's Fastify
  `config` and enforced by the identity module before the handler runs: no
  session is `401`, a session without the capability is `403`.
- **The ledger tables and their invariants** (migration
  `0005_inventory_ledger_core.sql`): `operations`, `inventory_movements`, and
  `inventory_balances`, with every rule below enforced by the database.
- **The internal posting engine** (`ledgerService.ts`,
  `infrastructure/ledgerRepository.ts`) — one trusted operation,
  `postMovement`, that appends a single normal movement and moves its balance.
  **It has no HTTP surface:** no route, no request schema, no handler, and
  nothing outside this module calls it yet. It is not receiving, not
  adjustments, and not counts — those workflows are thin callers that arrive in
  their own PRs. Callers describe the business event; the engine owns the
  movement's identity and the time it was recorded.

## The posting engine

`postMovement(command)` runs one transaction and commits all of it or none of
it (INV-5):

1. Reads the server clock **once**. That single `recordedAt` stamps the
   operation, the movement, and the balance. The engine takes a `Clock`
   dependency and never calls `new Date()`, and never `now()` in SQL.
2. Claims the operation id with
   `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`. Never check-then-insert,
   which races (INV-7).
3. **Generates the movement id** — after the claim succeeds, never before, so a
   retry mints no identity it has no use for. UUIDv7, from the same application
   generator as every other id; no database default, and not derived from the
   operation id.
4. Locks the `(variant_id, location_id)` balance with `SELECT ... FOR UPDATE`,
   creating the zero row first if that shelf has never held stock.
5. Derives `quantity_before` from the locked balance, `quantity_after` from the
   delta, and `previous_movement_id` from `last_movement_id`. **Stock is never
   calculated by summing the ledger**, and the caller never supplies before,
   after, or predecessor values.
6. Appends one movement, with `reverses_movement_id` always NULL.
7. Updates the balance projection to the new quantity and last movement.
8. Records `result_resource_type = 'inventory_movement'` and the movement id on
   the operation — the pointer only, never the request or response body.

### What the caller owns, and what the engine owns

The command describes a **business stock event**. The engine owns the permanent
identity of the record it produces and the time the system claims to have
recorded it.

| The caller supplies                           | The engine supplies               |
| --------------------------------------------- | --------------------------------- |
| `operationId`, `operationType`, `requestHash` | the movement id                   |
| `variantId`, `locationId`                     | `recordedAt`                      |
| `movementType`, `quantityDelta`               | `quantityBefore`, `quantityAfter` |
| `reasonCode`, `note`                          | `previousMovementId`              |
| `userId`                                      | the balance projection update     |
| `occurredAt`                                  |                                   |

- **Callers cannot choose a movement id.** It is the primary key of a permanent,
  immutable record; a caller that could pick it could name a record before it
  exists, or claim one that already does.
- **Callers cannot choose `recorded_at`.** It is the ledger's own account of
  when it learned about the stock, so it comes from the injected server clock.
- **`occurred_at` remains business time** and remains the caller's: a delivery
  counted this morning and entered this afternoon occurred this morning. It may
  precede `recorded_at`, and that is not an error. This engine applies no
  timestamp policy — how far back a given workflow accepts a business time is
  that workflow's rule, not the ledger's.
- **`user_id` comes from trusted workflow context.** The ledger is internal and
  knows nothing about Fastify: it trusts whatever workflow calls it. When
  receiving and the other workflows arrive, each will derive it from
  `request.actor.id` — the authenticated session — and **no request schema will
  ever accept a user id from the wire.**
- **`operationId` stays caller-generated**, and has to: it is how a retry names
  the command it is repeating. It is generated when the form opens and reused on
  every retry, including after a reload (INV-7).
- A canonical **request hash covers business fields only.** The movement id and
  `recorded_at` are not request fields, so nothing that hashes a request should
  reach for them. (The hashing utility itself is a later PR.)

**Retries.** A repeated operation id whose `operation_type` and `request_hash`
both match returns the movement the first attempt posted, and posts nothing —
found through the operation's result pointer, which is why **a caller never has
to remember a movement id to retry safely.** No new movement id is minted, no
timestamp is restamped, and the balance does not move again. A mismatch on
either is `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` (409). A matching operation
that records no usable movement result is an `INTERNAL` failure, never a second
movement.

The clock is sampled before the claim, because the `operations` row needs a
`created_at` at the moment it is inserted. A replay throws that reading away:
nothing is rewritten with it, and the original attempt's persisted timestamps
remain the authoritative ones.

A UUIDv7 collision on the movement id is handled as any other primary-key
violation: the transaction fails and rolls back. There is no retry loop and no
collision framework, because there is no collision to defend against.

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

**Two updates must each touch exactly one row** — the balance and the operation
result. Both rows were located earlier in the same transaction, so any other
count is a broken assumption: the engine raises and the unit of work rolls back
rather than leaving a movement whose projection never moved. Neither is an
upsert.

### Concurrency

At PostgreSQL's default `READ COMMITTED`, with no retry loop, no isolation
change, and no lock outside the database:

- **Writers to the same (variant, location) serialize** behind the
  `SELECT ... FOR UPDATE` on that chain's balance row. The second writer reads
  the quantity the first one committed, so `quantity_before` and
  `previous_movement_id` cannot be stale. The chain and the projection stay
  equal however the commands interleave.
- **First writers to a chain that has no balance row** contend on the lazy
  `INSERT ... ON CONFLICT DO NOTHING` instead, then on the row lock. Exactly one
  balance row and one opening movement result.
- **Independent chains stay independent.** A lock held on one (variant,
  location) does not delay posting to another.
- **Concurrent identical retries post once.** Callers that overlap with a
  request still in flight all receive the same persisted movement, and stock
  moves a single time. Exactly one of them claims the operation, so exactly one
  movement id is minted — the rest replay, which mints nothing.
- **A losing command leaves nothing behind** — no operation row, no movement,
  no partial balance change — whether it lost to the stock floor or to a
  conflicting reuse of its operation id.

These are covered by `tests/integration/inventoryPostingConcurrency.test.ts`,
which forces genuine transaction overlap and verifies it against
`pg_stat_activity` before releasing. They are PostgreSQL transaction and
row-lock guarantees on one database — nothing about multi-node behaviour.

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
- **Attribution.** `operation_id`, `user_id`, `occurred_at`, and `recorded_at`
  are `NOT NULL`, and adjustments require a `reason_code` (INV-11). `user_id`
  deliberately carries **no** foreign key until identity exists — a key pointing
  at a fiction is worse than none. Attribution is to the person, never to a
  machine: there is no device, terminal, or session column, and none is coming
  (ADR 9).
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
Transfers, multi-location stock behaviour, and location management (create /
rename / deactivate). Offline sync remains deferred too. No frontend behaviour
changes with this work.

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
