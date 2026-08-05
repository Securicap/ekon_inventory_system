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
  **It still has no HTTP surface of its own:** no route, no request schema, no
  handler. Callers describe the business event; the engine owns the movement's
  identity and the time it was recorded.
- **The receiving workflow** (`receivingService.ts`,
  `domain/receivingRequestHash.ts`) and `POST /api/inventory/receive` — the
  first production caller of the posting engine, and the first thing in the
  system that puts a row in the ledger. Adjustments, counts, and reversal are
  the workflows that follow, each in its own PR.
- **The current stock read** (`service.ts`,
  `infrastructure/balanceRepository.ts`) and `GET /api/inventory/balances` —
  how many units of every active variant are held at every active location,
  read from the balance projection. Requires `inventory.read`. It is the first
  thing that reads the ledger's projection out to a screen, and it writes
  nothing.

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
  knows nothing about Fastify: it trusts whatever workflow calls it. Receiving
  derives it from `request.actor.id` — the authenticated session — and every
  workflow after it does the same. **No request schema accepts a user id from
  the wire**, and the receiving schema refuses a body that offers one.
- **`operationId` stays caller-generated**, and has to: it is how a retry names
  the command it is repeating. It is generated when the form opens and reused on
  every retry, including after a reload (INV-7).
- A canonical **request hash covers business fields only.** The movement id and
  `recorded_at` are not request fields, so nothing that hashes a request reaches
  for them. The hash is the _workflow's_, not the engine's: each one decides
  what its command consists of and hands the engine a digest. Receiving's is
  below; the serialization it uses is `platform/hash/canonicalRequest.ts`.

**Retries.** `postMovement` answers a repeated operation id after its claim
loses; `findCompletedMovement` answers the same question as a read, before a
workflow validates anything about the present. One comparison serves both, and
only the claim decides ownership — the read cannot. A repeated operation id
whose `operation_type` and `request_hash`
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

## Receiving

Receiving records that **a positive quantity of one variant arrived at one
location at one business time**. That is the whole of it. There is no supplier,
no purchase order, no invoice, no cost, no document, and **no receipt record of
its own** — the inventory movement _is_ the receiving record. A separate
receipts table would be a second history to keep in step with the ledger, and
the ledger is the one that has to be believed. It is stock arriving, not
purchasing.

### `POST /api/inventory/receive`

Requires the **`inventory.receive`** capability, declared in the route's Fastify
`config` and enforced by the identity module before the handler runs: no session
is `401`, a session without the capability is `403`. The route parses the body,
takes the person from `requireActor(request)`, and calls the receiving service;
it contains no business logic, no role check, and never calls `postMovement`
itself.

```jsonc
// request
{
  "operationId": "0198f0a0-…", // client-generated, reused on every retry
  "variantId": "0198f0a0-…",
  "locationId": "0198f0a0-…",
  "quantity": 12, // whole units, strictly positive
  "occurredAt": "2026-08-04T10:00:00.000Z", // when the stock physically arrived
}
```

```jsonc
// 201 Created
{
  "operationId": "0198f0a0-…",
  "movementId": "0198f0a0-…", // server-generated, permanent
  "quantityAfter": 12, // on hand at that (variant, location) after the movement
}
```

The response is deliberately three fields. The chain pointer, the quantity
before, the request hash, and the operation row's state are how the server keeps
its own promises; a screen that has just booked in a delivery has no use for
them, and a client that could read them would come to depend on them.

**The server owns identity and the hash.** `user_id` comes from the session
cookie, never from the body — the schema is `.strict()`, so a request carrying
`userId` is _rejected_, not ignored, and the same goes for `movementId`,
`movementType`, `quantityDelta`, `recordedAt`, `quantityBefore`,
`quantityAfter`, `previousMovementId`, and `requestHash`. There is no
client-supplied request hash and no device, terminal, or machine identity
anywhere in the path (ADR 9).

**The workflow owns the movement type and the sign.** Receiving always posts a
`RECEIPT` with a positive delta. No request can choose either, so an endpoint
whose capability says _receive_ cannot be used to remove stock.

**Single item, on purpose.** One variant, one location, one quantity, one
business time. No arrays, no batches, no partial success, no per-line errors. A
screen with several lines sends several independent operations, each with its
own operation id, so one line failing cannot half-apply the others.

### The canonical request hash

The operation id says _which_ command this is; the hash says _what_ it was.
Together they let the posting engine tell a genuine retry from an operation id
reused for something else. It covers exactly six values:

```text
workflow    "inventory.receive"
variantId
locationId
quantity
occurredAt  normalized to an instant, so 10:00-05:00 and 15:00Z hash alike
actorId     from the session
```

Serialized as one sorted, type-tagged, escaped `name=type:value` line per field
(`platform/hash/canonicalRequest.ts`) and digested with SHA-256, so the digest
cannot depend on property order, whitespace, JSON formatting, or locale. It
contains **nothing the server generated** — no movement id, no `recorded_at`, no
balance, no chain pointer. Hashing a result would make every retry differ from
the attempt it repeats, and idempotency would fail exactly when it is needed.

`operationId` is deliberately not hashed either: the hash is stored _against_
the id, so including it would make every command hash uniquely and the
comparison could never fail.

### Retrying, and reusing an id for something else

- **Exact replay** — same operation id, same canonical command: `201` with the
  **same `movementId`** and the same balance. No second movement, no new
  movement id, no balance change, no new operation row. The answer comes from
  the operation's result pointer, which is why a client never has to remember a
  movement id to retry safely.
- **A different command under the same id** — a changed quantity, variant,
  location, business time, or a different signed-in person: `409`
  `OPERATION_REPLAYED_WITH_DIFFERENT_BODY`, and nothing is written.

Idempotency belongs entirely to the posting engine. Receiving adds no second
mechanism, no retry loop, and no lock.

### Settled first, present tense second

Receiving asks the engine what this operation already produced — `LedgerService.findCompletedMovement`
— **before** it checks anything about the variant or the location as they are
today:

1. **A completed operation** answers immediately with its original movement. No
   current-state check runs, so a retired variant or a closed location cannot
   make a settled receipt unanswerable. A retry of a delivery booked in this
   morning must still answer this evening, however the catalog changed in
   between; a client that never saw the first response would otherwise retry
   forever into a `409` over stock that is already on the shelf.
2. **A mismatched operation type or request hash** raises
   `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` from inside that lookup — before any
   validation. When an id is reused _and_ the variant has since been retired,
   both `409`s would be true; the right one names the id, because that is what
   the caller has to fix, and because the other answer would change the day the
   item came back.
3. **Anything else** — no operation row, or one claimed but not yet complete —
   returns `null`, and receiving validates the present and posts normally.

`findCompletedMovement` is a read on the pool. It takes no lock, claims nothing,
and **is not an idempotency mechanism**: it cannot create or complete an
operation, and `null` never means "this command is new". It sees committed rows
only, so a claim still in flight is invisible to it — which is correct, since an
uncommitted claim is not an answer to anybody.

That leaves the transactional claim inside `postMovement` as the sole authority
on who owns an operation id, and it is what makes the ordering race-safe:

- A concurrent first attempt that has not committed is invisible to the lookup,
  so both callers validate and both call `postMovement`. Exactly one claims;
  the other's `INSERT ... ON CONFLICT DO NOTHING` waits out the winner and
  replays inside its own transaction, from the same comparison. One movement.
- An operation that commits _between_ the lookup and the claim is caught by the
  claim, which is where it has always been caught.
- The window the ordering opens is therefore only this: a concurrent retry can
  validate the present state that a settled retry would have skipped. Both
  attempts are for the same command, sent seconds apart, so the entity was
  active for one of them; the loser replays either way.

The comparison itself lives in one function in `ledgerService.ts`, used by both
the pre-transaction lookup and the post-claim replay. No workflow queries
`operations` for itself.

### What receiving refuses, and with which status

| Situation                                                                                                   | Status | Code                                     |
| ----------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- |
| Malformed body, bad uuid or timestamp, zero / negative / fractional quantity, unknown or server-owned field | `400`  | `VALIDATION_FAILED`                      |
| No session, or one that no longer resolves                                                                  | `401`  | `UNAUTHENTICATED`                        |
| Signed in without `inventory.receive`                                                                       | `403`  | `FORBIDDEN`                              |
| Variant or location does not exist                                                                          | `404`  | `NOT_FOUND`                              |
| Variant or location is inactive                                                                             | `409`  | `CONFLICT`                               |
| Operation id reused for a different command                                                                 | `409`  | `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` |
| Anything unexpected                                                                                         | `500`  | `INTERNAL`                               |

An **inactive** variant or location is a `409` rather than a `404` because it
plainly exists: telling somebody holding a delivery that it does not would send
them looking for a typo instead of for whoever retired the item. Both are
checked with a focused query — one row, two or three columns — before the
transaction opens, so an unstockable request never claims an operation id, and
the id remains free for a corrected request. Foreign keys are the last line of
defence here, not the business rule: a constraint violation inside the
transaction would be a `500` that names no field.

These two rules apply to **new** commands only. A settled operation is answered
before they run — see _Settled first, present tense second_ above.

Variants belong to the **catalog** module, so the check goes through
`catalogService.findStockableVariant` rather than a query against
`product_variants`. Locations are this module's own table.

**Only the variant's own `is_active` is consulted today.** No production path
deactivates a product or a variant — the catalog creates and lists, and
`catalog.deactivate` has no route or service method — so an inactive product
with an active variant cannot currently arise. When catalog deactivation lands
it must carry this invariant with it:

> A variant is stockable only when both the variant **and its parent product**
> are active.

Whether that is enforced by cascading deactivation to variants or by widening
this check is a decision for that PR, not a guess made in advance here.

**Authentication precedes validation.** Enforcement is an `onRequest` hook, so
an anonymous request with a malformed body is `401` before anything in it is
parsed — answering `400` would tell a caller who is nobody which fields the
endpoint expects.

## Current stock

`GET /api/inventory/balances` answers the question the counter asks all day:
**how many units of every active variant are held at every active location.**

It is an **operational current-state view**, not a report and not history. There
is no date range, no valuation, no movement list, and no export. The ledger
remains the record of how the numbers got there, and nothing in this response
exposes any of it.

Requires the **`inventory.read`** capability, declared in the route's Fastify
`config` and enforced by the identity module before the handler runs: no session
is `401`, a session without the capability is `403`, and a `403` does not sign
anybody out. The route parses nothing, checks nothing, and knows nobody's role —
it calls the inventory service and sends what it gets.

```jsonc
// 200 OK
[
  {
    "variantId": "0198f0a0-…",
    "productId": "0198f0a0-…",
    "productName": "Bottled Water",
    "sku": "EKN-A2B3C4D5",
    "attributes": [{ "name": "size", "value": "1L" }],
    "totalQuantity": 17,
    "locations": [
      {
        "locationId": "0198f0a0-…",
        "locationName": "Main Store",
        "isDefault": true,
        "quantity": 5,
        "updatedAt": "2026-08-03T12:00:00.000Z",
      },
      {
        "locationId": "0198f0a0-…",
        "locationName": "Backroom",
        "isDefault": false,
        "quantity": 12,
        "updatedAt": "2026-08-03T12:00:00.000Z",
      },
    ],
  },
]
```

**No query parameters in this version.** No pagination, filtering, sorting, or
search — the whole active picture is a small bounded matrix for one shop, and
each of those is a decision better made against a real screen than guessed at
now.

### `inventory_balances` is the answer; the ledger is not consulted

`quantity_on_hand` is the authoritative current-stock projection, maintained in
the same transaction as the movement that changes it. This endpoint reads it as
it stands and **never sums `inventory_movements`** to derive a current quantity.
An integration test forces the two apart — it moves a balance row away from what
its movements add up to — and asserts the response follows the projection, which
is the only way to tell the two implementations apart when they agree.

`totalQuantity` is summed **in the response mapping**, from the location
quantities beside it. There is no total-stock column, no second projection, and
no second query: a total kept anywhere other than in the numbers it totals is a
number that can disagree with them.

### Zero stock, and the two kinds of zero

Every active variant is returned **whether or not it has ever held stock**, with
one entry for every active location. A variant with no movements and no balance
row at all is exactly the item somebody is looking for when they ask why nothing
was ever booked in against it, and an answer that omitted it would be read as
"we have none" rather than "nobody has ever recorded any".

An **absent balance row means zero.** Where there is no row:

```jsonc
{ "quantity": 0, "updatedAt": null }
```

`updatedAt` is what distinguishes the two zeroes, and both are real states:

| The shelf                             | `quantity` | `updatedAt`    |
| ------------------------------------- | ---------- | -------------- |
| has never held stock — no balance row | `0`        | `null`         |
| held stock and was drawn back to zero | `0`        | the row's time |

Nothing is written to answer a read. **No zero balance rows are created**, no
timestamps are stamped, and the current time is never substituted for a missing
one — a fabricated `updated_at` would claim a moment at which nothing happened.
A product's, variant's, or location's own `updated_at` is not a substitute
either: it answers a different question.

### Active only, and history is untouched

Only **active products, active variants, and active locations** appear. An
active variant under a retired product does not: the product has been withdrawn,
and presenting it on a stock screen would offer something the business no longer
sells.

This filters a present-tense operational view. **It changes and deletes
nothing** — every movement and every balance row of a retired item stays exactly
as it was, and stock sitting at a closed location is still on that shelf in the
database. It is simply not part of what the shop is asked to act on today, and
therefore not part of the totals.

Two empty states, both `200`:

- **no active variants** — `[]`, whatever locations exist;
- **no active locations** — every active variant, with `locations: []` and
  `totalQuantity: 0`. Nowhere to put stock is an operational problem for a
  screen to surface, not a server error.

### Ordering

Deterministic throughout, from `ORDER BY`, never from insertion order:

- **variants** — product name, then SKU, then variant id as the final
  tie-breaker;
- **locations within a variant** — the default location first, then by name,
  then by location id.

Attributes keep the catalog's existing order (normalized name), and are passed
through unchanged — never renamed, re-cased, or rebuilt here.

### Where the query goes, and how many there are

Products, variants, SKUs, and attributes belong to the **catalog** module;
locations and balances belong to this one. So the read is composed in the
**inventory application service** from three calls, not written as one
cross-module join — the same boundary receiving already respects when it asks
`catalogService.findStockableVariant` instead of querying `product_variants`:

1. `catalogService.listStockableVariants()` — active variants of active
   products, with product name, SKU, and attributes, already ordered (two
   queries inside the catalog: variants joined to products, then their
   attributes);
2. `listActiveLocations` — this module's active locations, already ordered;
3. `listBalancesForVariants` — this module's balance rows for exactly those
   variants.

The matrix is then built in memory: `active variants × active locations`, with
each cell filled from the balance row if there is one and zero if there is not.
The shape is a `LEFT JOIN` onto `inventory_balances`, and it is deliberately
**driven by the catalog rather than by the balance table** — starting from
`inventory_balances` would silently drop every never-stocked variant.

**Four bounded SQL statements for a non-empty catalog, and one when no stockable
variants exist** — the catalog read answers nothing, so neither of this module's
reads is issued. The count is constant with respect to catalog and location
size: there is no query per variant or per location and no N+1 behaviour. Four
hundred variants across three locations is still four statements.

Reading is kept out of the posting engine's repository. Every function in
`ledgerRepository.ts` takes a transaction client because a movement and its
balance must commit together; the read side lives in `balanceRepository.ts`,
which takes the pool, holds no transaction, takes no lock, and creates nothing.
`inventory_balances` is still written in exactly one place.

### Concurrency

An ordinary committed read at the existing isolation level — no row locks, no
advisory locks, no retry loop, no isolation change, and no cache. A request may
observe stock from just before or just after a concurrent receipt commits, which
is what "current" means. It cannot observe half of one: the movement insert and
the balance update commit together, so a receipt is either wholly visible or not
visible at all.

**No schema change was needed for any of this**, and none was made.

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

Adjustments, physical counts, and public reversal. Reversal posting itself.
Transfers, multi-location stock behaviour, and location management (create /
rename / deactivate). Offline sync remains deferred too.

The **receiving screen** now exists and calls `POST /api/inventory/receive` —
see [frontend/README.md](../../../../frontend/README.md). The **stock screen**
that reads `GET /api/inventory/balances` is the next PR; this one is backend and
shared-contract work only.

Deferred with the stock read specifically: movement history and any history
endpoint, low-stock thresholds, reserved stock and available-to-promise, costs
and valuation, pagination, server-side search and filtering, exports, caching,
and background refresh. None of them is needed to answer what is on the shelf
today, and several of them would quietly turn an operational read into a
reporting system.

Deferred with receiving specifically, and deliberately: suppliers, purchase
orders, invoices, costs, shipment records, receiving statuses, draft receipts,
attachments, lot numbers, expiry dates, serial numbers, barcode scanning, and
CSV import. None of them is a stock movement, and none of them is needed to
record that stock arrived.

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
