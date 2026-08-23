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
  system that puts a row in the ledger.
- **The current stock read** (`service.ts`,
  `infrastructure/balanceRepository.ts`) and `GET /api/inventory/balances` —
  how many units of every active variant are held at every active location,
  read from the balance projection. Requires `inventory.read`. It is the first
  thing that reads the ledger's projection out to a screen, and it writes
  nothing.
- **The stock removal workflow** (`removalService.ts`,
  `domain/removalRequestHash.ts`) and `POST /api/inventory/remove` — ordinary
  stock leaving: sold, damaged, or consumed internally. Posts an `ISSUE`
  movement of a negative delta through the same posting engine, under the new
  `inventory.remove` capability. It is the first thing in the system that takes
  stock _off_ a shelf, and the first workflow that can be refused by the stock
  floor.
- **The stock history read** (`movementHistoryService.ts`,
  `infrastructure/movementHistoryRepository.ts`, `domain/historyCursor.ts`) and
  `GET /api/inventory/movements` — the append-only ledger, paginated, filtered,
  and labelled. Requires `inventory.read`. It adds no table and changes no
  posting behaviour: the ledger was always the evidence, and this reads it.
- **The adjustment workflow** (`adjustmentService.ts`,
  `domain/adjustmentRequestHash.ts`) and `POST /api/inventory/adjust` — the
  recorded quantity was wrong. Posts an `ADJUSTMENT_IN` or an `ADJUSTMENT_OUT`,
  derived from the sign of the correction, under `inventory.adjust`.
- **The reversal workflow** (`reversalService.ts`,
  `domain/reversalRequestHash.ts`) and `POST /api/inventory/reverse` — one
  movement should never have been posted. Appends a compensating `REVERSAL`
  whose delta comes from the original row, under `inventory.reverse`. The first
  thing in the system that reaches back into settled history, and it does so by
  adding to it.
- **The stock-presence read** (`stockPresenceService.ts`) — the one question the
  catalog module may ask this one about balances: does this merchandise hold
  stock? It exists so archiving can be refused while any remains, without either
  module querying the other's tables. Read-only, no transaction of its own, and
  deliberately one method rather than a query API.

## Stock history

The ledger has recorded the evidence since 0005. `GET /api/inventory/movements`
makes it readable — what changed, by how much, from what to what, why, who
recorded it, when the stock moved, and when Ekon recorded that it had.

There is **no second history table**, no activity log, and no denormalized copy
of a movement anywhere. A history that could disagree with the ledger would be
worse than no history at all.

### `GET /api/inventory/movements`

Requires **`inventory.read`** — the same capability that answers what is on the
shelf today. History is inventory visibility: somebody who may see the numbers
may see how they got there, and a capability of its own would only have to be
granted to everyone who already holds this one.

The query is parsed with the shared schema exactly as a request body is, and it
is `.strict()`: a mistyped parameter is refused rather than dropped. A request
filtered by `varientId` would otherwise be answered with the whole ledger and
look like it had worked.

| Parameter      | Narrows to                                           |
| -------------- | ---------------------------------------------------- |
| `variantId`    | one variant, across every location                   |
| `locationId`   | one location, across every variant                   |
| `movementType` | one kind of change, from the shared vocabulary       |
| `recordedFrom` | movements recorded at or after this instant          |
| `recordedTo`   | movements recorded at or before this instant         |
| `limit`        | page size, 1–100, default 50                         |
| `cursor`       | where to resume, from a previous page's `nextCursor` |

Every filter is optional and every one narrows; there is none that widens, and
no way to ask for an unbounded answer. Omitting all of them asks for the most
recent page of everything.

```jsonc
// GET /api/inventory/movements?variantId=019...&limit=50
{
  "items": [
    {
      "id": "019...",
      "movementType": "ISSUE",
      "quantityDelta": -1,
      "quantityBefore": 7,
      "quantityAfter": 6,
      "reasonCode": "SOLD",
      "note": null,
      "occurredAt": "2026-08-23T14:20:00.000Z",
      "recordedAt": "2026-08-23T14:22:10.000Z",
      "operationId": "019...",
      "reversesMovementId": null,
      "variant": {
        "id": "019...",
        "productId": "019...",
        "productName": "Bel Ami",
        "brandName": "Steve Madden",
        "sku": "EKN-XXXXXXXX",
        "attributes": [{ "name": "color", "value": "Black" }],
      },
      "location": { "id": "019...", "name": "Main Store" },
      "actor": { "id": "019...", "displayName": "Marie Joseph" },
    },
  ],
  "nextCursor": "MjAyNi0wOC0yMy...",
}
```

### `occurredAt` and `recordedAt` are not the same fact

**`occurredAt` is business time** — when the stock physically moved, stated by
whoever recorded the movement. A delivery counted this morning and entered this
afternoon occurred this morning, so it may be earlier than `recordedAt`, and two
movements may be entered out of chronological order.

**`recordedAt` is server time** — when Ekon permanently recorded the fact, read
from the injected clock inside the posting transaction. It is the order the
ledger was written in, and because the ledger is append-only that order never
changes.

Both are returned on every record. Only one of them is an order.

### Ordering, and why it is `recordedAt`

`recorded_at DESC, id DESC`. Not `occurred_at`: a late entry stating an earlier
business time would slot itself into the middle of a feed somebody had already
read, and the ledger's insertion order would appear to rearrange itself. Sorting
by the immutable order avoids that entirely.

`id` breaks the tie. Ids are UUIDv7 and time-ordered, so within one millisecond
`id DESC` still reads newest-first, and the pair is unique because `id` is the
primary key — which is what makes the keyset comparison below total rather than
merely mostly-total.

The **date filters name `recordedAt` explicitly**, and that is a decision rather
than a shorthand. The feed is ordered by recorded time, so a range on the same
column composes with the cursor and reads from the same index; a range on
`occurredAt` would answer a different question — "what happened on the shop
floor that day" — against a column that is neither the sort key nor indexed.
They are deliberately not called `from` and `to`: with two timestamps in the
ledger, an unqualified name is a guess about which one somebody meant.

### Pagination is a keyset cursor, never an offset

`nextCursor` encodes an exact position — `recorded_at` and the movement id —
and the next page resumes strictly after it. It is `null` on the last page and
only then; a page that comes back full with a null cursor is the end, not an
invitation to ask again.

An `OFFSET` into an append-only table that grows at the front would let a
movement posted while somebody is reading page four shift a row across a page
boundary, so it appeared twice or not at all. A keyset resumes at a position,
so it cannot. It also reads one index range instead of counting past every
earlier row, which is what keeps a deep page as cheap as a shallow one
(`inventory_movements_recorded_at_idx`, 0011).

The cursor is base64url and **opaque on purpose**. It is not encryption and is
not pretending to be — it holds a timestamp and an id the same response already
returned. What the encoding buys is that it does not look structured, so nobody
constructs one, and the format can change without breaking anybody who kept to
the contract. A cursor that does not decode is a `VALIDATION_FAILED` naming the
field, never a silent restart from the first page.

### Names are current labels, not historical snapshots

This is the one thing about this feed that could reasonably be misread, so it is
stated plainly here and in the shared contract.

The ledger permanently stores ids, quantities, the movement type, the reason,
the note, both timestamps, and the actor's id. It does **not** store the
product's name, the brand, the location's name, or the person's display name.
Those are resolved at read time from the tables that own them today.

> IDs and movement facts are historical ledger evidence. Display names are
> current labels resolved for those permanent IDs at read time.

So renaming a product changes what an old movement _displays_ while the movement
still refers to the same immutable variant id and SKU. Nothing here is a
snapshot of what anything was called on the day it happened, and it must not be
read as one. If the business ever needs "what was this product called on that
date", that is a schema decision about snapshotting history — an ADR of its own,
not a read model.

### History is not the current-stock list

`GET /api/inventory/balances` filters to active variants of active products at
active locations, because it answers what may be stocked today. History does
none of that filtering, and must not: a movement posted last year against
merchandise the shop has since retired, or on a shelf that has since closed, is
exactly the record somebody goes looking for.

That is why the catalog is asked through `findVariantLabels` rather than
`listStockableVariants` — the second would silently drop those movements — and
why locations are resolved with `findLocationLabels` rather than
`listActiveLocations`.

### The actor may not resolve, and the id is kept anyway

`actor.id` is permanent ledger evidence and is always present: `user_id` is
`NOT NULL` on every movement. `actor.displayName` is a current label and is
`null` when the id does not resolve to a user today.

That is a real state rather than a defensive one.
`inventory_movements.user_id` deliberately carries **no foreign key** onto
`users` (INV-11): movements existed before the identity module did, and some
carry actor uuids that were never accounts. The id is never discarded because a
name cannot be found, and no name is ever invented to fill the gap. A user who
has been deactivated still resolves normally — their name has to stay readable
on every movement they posted, which is what INV-16 deactivates rather than
deletes them for.

### Where the queries go, and how many there are

**Five bounded statements for a page of any size**, and one when the page is
empty:

1. the page of movements — one statement, `limit + 1` rows;
2. the variant labels, from the **catalog** module's service (two inside it: the
   variants with their products and brands, then their attributes);
3. the location labels, from this module's own location repository;
4. the actor display names, from the **identity** module's user service.

The count is constant with respect to how many movements come back. The ids are
collected first and each lookup is asked once, in bulk — there is no query per
movement, and nothing loads the ledger into memory to filter it there.

The extra row read at step 1 is never returned. It is how the service knows
whether another page exists without counting the rest of the ledger, and it is
what makes `nextCursor` null exactly on the last page rather than one page late.

### Module boundaries

This module owns `inventory_locations`, `inventory_movements`, and
`inventory_balances`, and reads nothing else. Merchandise names belong to the
catalog and user names belong to identity, so both are asked for through those
modules' application services — `catalog.findVariantLabels` and
`identity.findUserDisplayNames`, each a narrow bulk read that returns labels and
nothing more. No SQL in this module names `product_variants`, `products`,
`brands`, or `users`, and the lint rule forbids importing either module's
internals.

An id that resolves to nothing is absent from those results rather than an
error. The caller holds permanent ledger ids and decides what a missing label
means; another module does not get to decide that a movement is unreadable.

### It writes nothing

No transaction is opened, no lock is taken, no clock is read, and no balance row
is created — including for a shelf that has never held stock, which a read has
no business bringing into existence. There is no `INSERT`, `UPDATE`, or `DELETE`
anywhere in the history read path; the database refuses the last two on this
table regardless (INV-1), and `scripts/check-conventions.mjs` fails the build on
either appearing in source.

An explicit test digests every movement and every balance before and after a
series of history requests and asserts they are identical.

### What it does not do

`reversesMovementId` is on every record and is `null` on all of them, because
reversal posting is not implemented. It is in the contract now so the evidence
model does not have to change shape when PR 5 adds corrections. There is no
reversal endpoint, no correction workflow, and no way to mutate a movement here.

`previousMovementId` is **not** exposed. It is the chain pointer that makes a
shelf's history unforkable (INV-4) — an integrity mechanism rather than a
business fact — and it answers nothing `quantityBefore` and `quantityAfter` do
not already answer.

`ISSUE` with reason `SOLD` is returned as exactly that, and is deliberately not
collapsed into a `SALE`. The ledger records that stock left and why; there is no
sale entity in this system, and `Remove → SOLD` is transitional rather than the
permanent sales architecture (ADR 11). Movement types cross the wire as their
stable machine values — localization is the interface's problem, not the
ledger's.

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
| Merchandise not `ACTIVE` (effective lifecycle), or location inactive                                        | `409`  | `CONFLICT`                               |
| Operation id reused for a different command                                                                 | `409`  | `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` |
| Anything unexpected                                                                                         | `500`  | `INTERNAL`                               |

Withdrawn merchandise or an inactive location is a `409` rather than a `404`
because it plainly exists: telling somebody holding a delivery that it does not
would send them looking for a typo instead of for whoever withdrew the item.
Neither refusal claims an operation id — the location is checked before the
transaction opens, and the merchandise check runs **inside** it, so a refusal
rolls the claim back with everything else and the id remains free for a
corrected request. Foreign keys are the last line of defence here, not the
business rule: a constraint violation inside the transaction would be a `500`
that names no field.

Both rules apply to **new** commands only. A settled operation is answered
before either runs — see _Settled first, present tense second_ above.

Variants belong to the **catalog** module, so the check goes through
`catalogService.findVariantForReceiving` rather than a query against
`product_variants`. Locations are this module's own table.

**Receiving requires effective `ACTIVE`**, and the catalog decides what that
means:

> A variant is never more available than its parent product, so its effective
> status is the stricter of the two — and receiving is the one operation
> `DISCONTINUED` refuses.

Each workflow asks the question named after what it is about to do —
`findVariantForReceiving`, `findVariantForIssue`, `findVariantForCorrection` —
and each service's dependency is narrowed to its own (`Pick<CatalogService,
'findVariantForReceiving'>`), so receiving **cannot** reach the issue rule even
by accident. That matters here more than it reads: the two genuinely differ, and
a workflow that called the wrong one would either refuse a legitimate sale of
discontinued stock or accept a delivery of merchandise the shop stopped buying.

**The check runs inside the posting transaction, and it locks.** That is what
makes archive safety real rather than hopeful: the catalog reads the merchandise
rows `FOR SHARE`, so a lifecycle change cannot commit between the answer and the
movement it authorized. See INV-19 for the lock protocol and the concurrency
test that stages both directions of the race.

**Authentication precedes validation.** Enforcement is an `onRequest` hook, so
an anonymous request with a malformed body is `401` before anything in it is
parsed — answering `400` would tell a caller who is nobody which fields the
endpoint expects.

## Stock removal

Removal records that **a positive quantity of one variant left one location for
one reason at one business time.** It is the counterpart to receiving and the
other half of the loop a shop lives in: stock comes in, stock goes out.

```
POST /api/inventory/remove      inventory.remove      ISSUE, quantity_delta < 0
```

### `ISSUE` is not `ADJUSTMENT_OUT`, and the difference is permanent

This is the decision the whole PR turns on.

| What happened                                                     | Movement                 |
| ----------------------------------------------------------------- | ------------------------ |
| A customer bought three bottles                                   | `ISSUE` / `SOLD`         |
| Two bottles broke and were discarded                              | `ISSUE` / `DAMAGED`      |
| One bottle was used by staff                                      | `ISSUE` / `INTERNAL_USE` |
| The system says 15, the shelf holds 13, and an old error is found | `ADJUSTMENT_OUT`         |

An **issue** says stock genuinely left the shelf. An **adjustment** says the
recorded balance was wrong and somebody corrected it downward — the stock had
already gone, or had never been there at all. The two look identical in a
balance and mean opposite things in a history: the first is trade, the second is
a recording error. A shop that cannot tell them apart cannot answer "how much
did we sell this month?" or "how much are we losing?", and both questions are
asked of the same column.

The ledger is append-only, so a movement written under the wrong one of them is
wrong **forever**: a compensating movement can undo the quantity but cannot
un-say what the original claimed happened. That is why the distinction lives in
the movement vocabulary rather than in a reason code somebody could pick
carelessly, and why routine removal did not simply reuse `ADJUSTMENT_OUT`.

The type is `ISSUE` and not `SALE`, `ORDER`, `SHIPMENT`, or `RETURN`. Those name
business domains this system does not have, and a permanent ledger column that
referred to one would be a claim about a module nobody has designed. **Stock
leaving is the fact; whether it was sold is the reason.**

### `SOLD` is a reason, not a sales module

There is no sale entity here, no transaction, no receipt, no customer, no
payment, no tax, no line item, no price, no revenue, and no refund. The
inventory ledger records only _why_ stock left. A point-of-sale module, if one
is ever built, would call this workflow — or an orchestration above it — rather
than teach the ledger about money. Nothing in this PR designs that.

### The reasons

A closed set in `@ekon/shared`, deliberately short:

```text
SOLD           a customer bought it
DAMAGED        broken, spoiled, or otherwise unsellable, and discarded
INTERNAL_USE   the business consumed it itself
OTHER          a legitimate removal that is none of the above
```

These are the categories somebody at a counter can answer honestly without
stopping to think, which is the only kind that stays accurate. A longer list
gets used as a guess, and a guess in a permanent ledger is worse than a coarse
truth. `OTHER` exists because the alternative is somebody choosing a _wrong_
reason from a list with no right one.

The public request field is **`reason`**; the ledger column is `reason_code`,
and the workflow maps one to the other unchanged. The request schema _refuses_ a
`reasonCode` field outright — a client that could write the column directly
could store a reason no screen offers and no report counts. **The stored value
is the code, never a translation**: `SOLD` means the same thing in the database
whatever language the person choosing it was reading, and it is still readable
when the interface has been rewritten twice. Free text is not accepted at all: a
reason somebody can type is a reason nobody can count.

`ISSUE` requires a reason at the database level (`inventory_movements_reason_required`,
0008), alongside both adjustment types. The type says stock left; the reason
says whether that was trade or loss, and the movement without it is half a
record.

### `POST /api/inventory/remove`

Requires the **`inventory.remove`** capability, declared in the route's Fastify
`config` and enforced by the identity module before the handler runs: no session
is `401`, a session without the capability is `403`. It is deliberately **not**
`inventory.adjust`. Recording that stock left is what somebody at the counter
does all day; correcting a balance that was wrong is authority over the records
themselves, and gating the first behind the second would have handed every
employee the power to make a shortfall disappear in order to let them record a
sale. All four roles hold `inventory.remove`, including `EMPLOYEE`; only
`inventory.adjust` remains withheld from them.

Receiving keeps its own endpoint and its own capability. There is no generic
`/api/inventory/movements` with a direction field: booking in a delivery and
taking a bottle off the shelf are different business acts that different people
are trusted with, and a generic endpoint would make that difference a value in a
body rather than a door somebody was given a key to.

```jsonc
// request
{
  "operationId": "0198f0a0-…", // client-generated, reused on every retry
  "variantId": "0198f0a0-…",
  "locationId": "0198f0a0-…",
  "quantity": 3,               // positive, whole units — the workflow owns the sign
  "reason": "SOLD",
  "occurredAt": "2026-08-06T14:30:00.000Z"
}

// 201, and 201 again on an exact retry
{
  "operationId": "0198f0a0-…",
  "movementId": "0198f0a0-…",
  "quantityAfter": 7
}
```

**The request quantity is positive, always.** A caller never sends
`quantityDelta: -3`. Negation happens once, inside the workflow that owns the
meaning, which keeps a signed number out of the contract, out of the request
hash, and out of every screen — and means a request that could add stock through
the removal endpoint cannot be written. The schema is `.strict()`, so `userId`,
`movementId`, `movementType`, `quantityDelta`, `recordedAt`, `quantityBefore`,
`quantityAfter`, `previousMovementId`, `requestHash`, `operationType`,
`reasonCode`, and `note` are all _refused_ rather than ignored.

**`occurredAt` is business time**, exactly as in receiving: when the stock
physically left. It may precede the server's `recorded_at`, an offset is
accepted as well as `Z`, and the server normalizes to an instant once — before
hashing and before posting — so `09:30-05:00` and `14:30Z` are the same command.
A future timestamp is not refused; shop clocks drift, and blocking a sale over
four minutes would be enforcing nothing the ledger depends on.

**The actor comes from the session.** `requireActor(request)` reads what the
enforcement hook resolved, and the route passes that id to the service, which
hands it to the engine as `user_id`. No request schema accepts one.

The response is `movementResultSchema` — the same three fields receiving
answers with, written once in `@ekon/shared` because both workflows genuinely
answer the same question. The reason is not echoed: the client sent it.

### The canonical request hash

Seven fields, and the workflow owns them:

```text
workflow      always "inventory.remove"
variantId
locationId
quantity      the public, positive number
reason
occurredAt    normalized to an instant, serialized as ISO-8601 UTC
actorId       from the session, never from the body
```

Each one changes the digest independently, which is what lets the posting engine
tell a retry from an operation id reused for something else. `workflow` is what
keeps a removal from colliding with a receipt of the same size at the same
moment, and what will keep it apart from a future point-of-sale workflow that
also posts `ISSUE` movements.

**The positive quantity is hashed, not the negative delta.** The digest is of
the request that was made, and there is exactly one way to state it — a hash
with two spellings of one command cannot recognize a retry. The movement type
and the delta are deliberately absent for the same reason they are derived:
`inventory.remove` always posts an `ISSUE`, and the delta is always the negation
of `quantity`, so a field that cannot vary independently would look like
protection and provide none.

Absent for the usual reasons: the movement id, `recorded_at`, the quantities
before and after, the predecessor pointer — all of them the ledger's _answer_ to
this command — and the operation id itself, which is what the hash is stored
against. The generic canonicalization is `platform/hash/canonicalRequest.ts` and
is not reimplemented; `domain/removalRequestHash.ts` is the field set and
nothing else.

### Settled first, present tense second

Removal follows receiving's ordering exactly:

```text
build the canonical claim
    ↓
ask the engine what this operation already produced   ← findCompletedMovement
    ↓  completed: return that movement, and stop
    ↓  a different body under this id: 409, here, before anything else
validate the variant and the location as they are today
    ↓
postMovement
```

An item sold in the morning and retired from the catalog that afternoon must
still answer its own retry. The stock has already left the building; a client
that never saw the first response would otherwise retry forever into a `409`
about an item it is no longer asking to change. And an operation id used for two
different commands is a conflict about the id, not a fact about the variant —
reporting it as "this item is inactive" would send somebody to fix the wrong
thing, and would change its answer the day the item came back.

`findCompletedMovement` decides nothing about whether a command is _new_. The
transactional claim inside `postMovement` remains the only authority on who owns
an operation id. There is no second idempotency mechanism.

### The stock floor

**Removal never reads the balance to decide whether it may proceed.** A
pre-check would be stale by the time it was used, and two callers could each be
told there was enough. The posting engine holds the `(variant, location)` balance
row under `SELECT ... FOR UPDATE`, derives `quantity_after`, and refuses
`INSUFFICIENT_STOCK` (`422`) if it would go below zero — inside the same
transaction that would have written the movement, so nothing commits.

What the workflow must never do, and does not:

- remove part of what was asked for;
- clamp the quantity to what happened to be available;
- create negative stock;
- post a zero movement;
- take the shortfall from another location.

**The requested location is the location stock leaves.** There is no fallback to
wherever the units happen to be — that would be a transfer nobody recorded.

A refusal leaves the ledger exactly as it found it: no movement, no balance
change, and no `operations` row, so the operation id is still free for a
corrected request.

Concurrency is the engine's, unchanged: no advisory lock, no retry loop, no
isolation change, no application mutex. With ten on the shelf and two concurrent
removals of seven, exactly one succeeds, the other is refused, the balance ends
at three, and the loser leaves nothing durable behind. That is asserted over
HTTP in `tests/integration/inventoryRemoval.test.ts`, with the overlap forced
and verified against `pg_stat_activity` rather than hoped for — the same barrier
the posting engine's own concurrency suite uses, shared in
`tests/helpers/ledgerConcurrency.ts`.

### What removal refuses, and with which status

| Situation                                                                                                                   | Status | Code                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- |
| Malformed body, bad uuid or timestamp, zero / negative / fractional quantity, unknown reason, unknown or server-owned field | `400`  | `VALIDATION_FAILED`                      |
| No session, or one that no longer resolves                                                                                  | `401`  | `UNAUTHENTICATED`                        |
| Signed in without `inventory.remove`                                                                                        | `403`  | `FORBIDDEN`                              |
| Variant or location does not exist                                                                                          | `404`  | `NOT_FOUND`                              |
| Merchandise `ARCHIVED` (effective lifecycle), or location inactive                                                          | `409`  | `CONFLICT`                               |
| Operation id reused for a different command                                                                                 | `409`  | `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` |
| The shelf does not hold that much                                                                                           | `422`  | `INSUFFICIENT_STOCK`                     |
| Anything unexpected                                                                                                         | `500`  | `INTERNAL`                               |

`422` for a shortfall is the platform's existing mapping for
`INSUFFICIENT_STOCK` and is not special-cased here: the request was well formed
and understood, and the shelf could not satisfy it.

Entity validation goes through this module's own location table and through
`catalogService.findVariantForIssue` — the same shape receiving uses, and
deliberately **not the same question**:

> Removal permits `ACTIVE` **and `DISCONTINUED`**, and refuses only `ARCHIVED`.

Discontinuing merchandise is a decision about replenishment, not about the units
already on the shelf: they are still sold to real customers, and a system that
refused to record it would not stop the sale — it would only stop knowing about
it. `ARCHIVED` is refused deliberately rather than left to be implied by the
fact that archived merchandise has no stock to issue: the lifecycle is enforced
on its own terms.

Everything else matches receiving — statuses, the `409`-not-`404` rule for
merchandise that plainly exists, the in-transaction lock, and authentication
preceding validation. See _What receiving refuses, and with which status_ above;
the differences are the capability, the wider lifecycle rule, and the extra
`422`.

**Removing the last unit is a success.** `quantityAfter: 0` is an answer: the
shelf is empty, not the request refused.

## Adjustments

`POST /api/inventory/adjust` records that **the recorded quantity was wrong**.
Nothing physical happened: no delivery arrived, no customer bought anything, and
no unit moved. The number was wrong, and this corrects it.

### An adjustment is not a removal, and not a receipt

An `ISSUE` says stock genuinely left through ordinary operations. A `RECEIPT`
says stock genuinely arrived. An `ADJUSTMENT_OUT` says the balance was too high
and somebody corrected it downward — the stock had already gone, or had never
been there at all.

They look identical in a balance and mean opposite things in a history: one is
trade, the other is a recording error. This ledger is append-only, so a movement
written under the wrong one of them is wrong forever, and no compensating
movement can un-say what the row claimed. That is why they are different
movement types under **different capabilities**, and why `inventory.adjust` is
deliberately not granted alongside `inventory.remove` in the default seed:
recording that stock left is what somebody at the counter does all day, and
making a shortfall disappear is authority over the records themselves.

### An adjustment is not a reversal either

When the wrong movement is known, **reverse it** — the correction is linked to
the mistake, the quantity is derived from the row, and neither can be reversed
twice. An adjustment is what is left when there is no single movement to point
at: a receipt nobody entered, a quantity mistyped weeks ago and discovered now,
units found on a shelf with no history behind them.

### And it is not a physical count

A count observes reality; reconciliation changes the system through a
`COUNT_RECONCILIATION` that records what was expected and what was seen (INV-9).
Adjusting a balance to agree with a count would destroy the variance, which is
the only signal the shop had that something is wrong. Counts are PR 6 and
nothing here anticipates them.

### `POST /api/inventory/adjust`

Requires **`inventory.adjust`**. `201`, and `201` again on a retry.

```jsonc
// request
{
  "operationId": "0198f0a0-…", // generated when the form opens, reused on retry
  "variantId": "0198f0a0-…",
  "locationId": "0198f0a0-…",
  "quantityDelta": -2,            // signed; the server derives the movement type
  "reason": "DATA_ENTRY_ERROR",
  "note": "Delivery of 12 entered as 21", // optional; required for OTHER
  "occurredAt": "2026-08-03T10:15:00.000Z"
}

// 201 Created
{
  "operationId": "0198f0a0-…",
  "movementId": "0198f0a0-…",
  "quantityAfter": 8
}
```

**The delta carries a sign, and this is the only workflow whose quantity does.**
Receiving always adds and removal always subtracts, so each states a positive
number and derives its own direction; an adjustment can go either way, and the
direction is the caller's statement about which way the record was wrong.
Splitting it into two endpoints would put the same decision in a URL; splitting
it into a positive quantity plus a direction word would give one command two
spellings — one too many for a hash that has to recognize a retry.

**The client never names the movement type.** `ADJUSTMENT_IN` or
`ADJUSTMENT_OUT` follows from the sign, in `adjustmentTypeFor`, and the posting
engine independently refuses a type whose sign disagrees with its delta. A
client that could send both could post an increase that removed stock.

### The reasons

`DATA_ENTRY_ERROR`, `MISSED_MOVEMENT`, `OTHER` — and they describe **the
record**, not the stock. That is the whole difference from `REMOVAL_REASONS`:

- `DATA_ENTRY_ERROR` — the quantity recorded is not the quantity meant. A
  delivery of 12 entered as 21, or the same receipt entered twice.
- `MISSED_MOVEMENT` — stock genuinely moved and was never recorded at all. A
  delivery booked in on paper, a sale rung up while the system was unreachable,
  merchandise found on a shelf that nobody entered.
- `OTHER` — anything else, and it **requires a note**. The alternative is
  somebody choosing a wrong reason from a list with no right one, and a wrong
  reason in a permanent ledger is worse than an unspecific one with a sentence
  beside it.

`SOLD` is not here and never will be: stock that was sold left the shelf and is
_removed_; a sale nobody recorded is a `MISSED_MOVEMENT`. Neither are
`SHRINKAGE`, `THEFT`, or `MISCOUNT` — those are conclusions about a variance,
and a variance is what a physical count produces. Offering them would invite
adjusting a balance to whatever was last counted and recording a guess about
why, which is precisely the flattening that stops a shop noticing it is being
stolen from.

### What an adjustment shares with every other workflow

The operation claim, the balance lock, the chain pointer, the stock floor, the
replay, and the atomic projection update — all of it is the posting engine's,
unchanged. An adjustment can no more take stock below zero than anything else
can: a correction of −4 against a shelf holding 3 is `INSUFFICIENT_STOCK`
(`422`), nothing is clamped, and nothing partial is applied.

The canonical request hash covers eight business fields —
`workflow, variantId, locationId, quantityDelta, reason, note, occurredAt,
actorId`. The **note is in it**, unlike in any other workflow, because it is the
only workflow that has one and it is a business field: an adjustment whose note
changed from "counted wrong" to "delivery never entered" is a different account
of what happened, and one operation id across the two is a `409`.

---

## Reversal

`POST /api/inventory/reverse` undoes one movement by **appending its
compensation**.

```text
wrong movement
    ↓
REVERSAL of it
    ↓
optional fresh correct movement
```

### Nothing is edited and nothing is deleted

The original row keeps its id, its type, its quantities, its reason, its actor,
and its place in the chain. A new `REVERSAL` beside it names it through
`reverses_movement_id`. Anyone reading the ledger afterwards sees both the
mistake and the remedy, which is the entire difference between a corrected
record and an altered one (INV-1, INV-2). The database would refuse an `UPDATE`
or a `DELETE` on this table in any case, and `scripts/check-conventions.mjs`
fails the build on either appearing in source.

### The original movement is the authority

The variant, the location, the quantity, and the direction are read off the
original row **inside the posting transaction**. The request schema refuses all
four, plus `movementType` and `reversesMovementId`, because each is derivable
and a second statement of a derived value can only ever disagree with the first.
A client that could state the quantity could "reverse" a receipt of 10 by 3 and
leave the ledger claiming a correction it never made.

### `POST /api/inventory/reverse`

Requires **`inventory.reverse`**, which is deliberately **not**
`inventory.adjust`. They are separate powers: an adjustment states a new number,
a reversal reaches back into settled history and takes one of its movements out
of the balance. A shop may well want the first without the second.

```jsonc
// request
{
  "operationId": "0198f0a0-…",
  "movementId": "0198f0a0-…", // the movement that was wrong
  "note": "Delivery entered twice", // optional
  "occurredAt": "2026-08-03T10:15:00.000Z" // when the correction was made
}

// 201 Created — the same three fields every command answers with
{
  "operationId": "0198f0a0-…",
  "movementId": "0198f0a0-…", // the REVERSAL's id, not the original's
  "quantityAfter": 0
}
```

`occurredAt` is the **correction's** business time, not the original movement's.
The mistake happened when it happened; this is when somebody put it right.

There is no `reason`: a reversal carries its reason in the movement it reverses,
which is what makes it a reversal rather than a fresh movement in the opposite
direction. The ledger requires a reason code for issues and adjustments only
(INV-11).

### The transaction, step by step

`postReversal` in `ledgerService.ts`, and the order is the design:

1. **claim the operation** — a retry is answered here and posts nothing;
2. **read the original** — it must exist (`404`), and must not itself be a
   `REVERSAL` (`409`);
3. **run the workflow's lifecycle precondition**, now that the variant is known;
4. **lock the balance**, which serializes this against every other writer on the
   same (variant, location) chain;
5. **only then** ask whether the original has already been reversed — after the
   lock, so a reversal committed by the writer this one queued behind is
   visible. Asking before the lock would read a stale snapshot and two reversals
   would both believe they were the first;
6. derive `-original.quantityDelta`, check the stock floor, append the
   `REVERSAL`, move the projection, complete the operation.

Step 5 is not the guarantee. **`UNIQUE (reverses_movement_id)` is**, and it holds
even against a caller that never took the lock — a lost race surfaces as that
constraint and is translated into the same `409` the check would have given,
never a `500` and never a second movement that removed the stock twice.

Since 0012 the database also refuses a reversal of a reversal and a reversal
naming a movement on another chain, both as foreign keys. See INV-2.

### Reversal works against the current balance

```text
Receipt  +10  → balance 10
Issue     −3  → balance  7
Reverse the receipt (−10) → would leave −3
```

That reversal is **refused** with `INSUFFICIENT_STOCK` (`422`). Stock never goes
below zero, for any role, by any path (INV-8), and the existence of a historical
receipt is not permission to break the floor. The remedy is stated rather than
implied: correct the later movements first — reverse the issue, then the receipt
— which is more history, not less. Nothing is clamped and nothing is partially
reversed.

### Lifecycle and corrections

A correction concerns **ledger truth**, not replenishment policy, so it does not
reuse the receiving or the removal rule:

- `DISCONTINUED` merchandise can always be corrected. Discontinuing something on
  Friday must not make Thursday's mis-keyed receipt permanent.
- `ARCHIVED` merchandise cannot. A correction would put units back on a shelf
  the archive asserts is empty, behind a status that has removed the item from
  every operational screen.

The remedy is explicit: **restore it to `DISCONTINUED`, correct the ledger,
archive it again.** No workflow in this system changes a lifecycle to get its own
write through — a status change that quietly happened as a side effect of a
correction would be the least inspectable thing here.

### In history

A reversal appears in `GET /api/inventory/movements` like any other movement,
and filtering by `movementType=REVERSAL` works through the existing contract
with no special case. Two fields carry the relationship:

- `reversesMovementId` — on the reversal, pointing at what it undid;
- `reversedByMovementId` — on the original, pointing at the reversal.

The second is **derived, not stored**: the ledger keeps one pointer, and the
history query reads it back through the unique index with a single `LEFT JOIN`.
It is not an N+1 and cannot become one — `UNIQUE (reverses_movement_id)` means
the join matches at most one row per movement, so it can neither multiply a page
nor need a `DISTINCT`. It is there because a corrected receipt that did not say
so would read as stock the shop still received, and somebody would go looking
for where it went.

---

## Current stock

`GET /api/inventory/balances` answers the question the counter asks all day:
**how many units of every operational variant are held at every active
location.**

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

### Operational merchandise only, and history is untouched

Merchandise appears while its **effective lifecycle** — the stricter of the
variant's own status and its product's — is `ACTIVE` or `DISCONTINUED`, at every
active location.

**`DISCONTINUED` merchandise is here, and that is the point.** The shop stopped
reordering it; the units on the shelf are still real, still sold, and still the
business's property. A stock screen that dropped them would strand inventory —
and stranded stock leaves the shelf anyway, with the ledger the only thing that
does not know. `ARCHIVED` merchandise is absent, which is honest only because
archiving is refused while any stock remains (INV-19): there is nothing left to
hide.

Which statuses those are is the **catalog's** rule, asked for through
`listOperationalVariants()` and never restated here.

This filters a present-tense operational view. **It changes and deletes
nothing** — every movement and every balance row of archived merchandise stays
exactly as it was, and stock sitting at a closed location is still on that shelf
in the database. It is simply not part of what the shop is asked to act on
today, and therefore not part of the totals.

Two empty states, both `200`:

- **no operational variants** — `[]`, whatever locations exist;
- **no active locations** — every operational variant, with `locations: []` and
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
  six values in `shared/src/movements.ts` (0005, widened by 0008 to admit
  `ISSUE`). An integration test compares the two sets, so the database and the
  wire format cannot drift.
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
  are `NOT NULL`, and `inventory_movements_reason_required` (0008, replacing
  0005's adjustment-only constraint) demands a `reason_code` for an `ISSUE` and
  for both adjustment types (INV-11). `user_id`
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

Physical counts and their reconciliation — PR 6. Transfers, multi-location stock
behaviour, and location management (create / rename / deactivate). Offline sync
remains deferred too.

Every screen for what this PR added is **PR 7**: there is no adjustment form, no
reversal button, and no history view. The API is complete and the interface is
not, deliberately and in that order.

Deferred with adjustments specifically: bulk or multi-line adjustments, an
approval workflow above them, configurable or per-shop reason administration,
and any aggregation of corrections into a report. Deferred with reversal:
reversing a whole operation rather than a movement, partial reversal (which is
an adjustment, and saying otherwise would let a client choose a reversal's
quantity), and any automatic re-posting of a corrected command.

The **removal screen** now calls this endpoint — see
[frontend/README.md](../../../../frontend/README.md). It drives its choices from
`GET /api/inventory/balances`, shows what each shelf holds, refuses a zero shelf
as a choice, and treats `INSUFFICIENT_STOCK` as a definitive refusal that a new
command must answer rather than a retry. Deferred with removal specifically, and
deliberately: sales,
customers, prices, payments, taxes, receipts, refunds, supplier and purchase
returns, free-text or per-shop reason codes, notes, multi-line or batch removal,
barcode scanning, and any reservation or allocation of stock. None of them is a
stock movement, and none of them is needed to record that stock left.

The **receiving screen** calls `POST /api/inventory/receive`, and the **stock
screen** now reads `GET /api/inventory/balances` — see
[frontend/README.md](../../../../frontend/README.md). It renders the response as
it arrives, zeroes and never-stocked shelves included, searches it in the
browser, and re-reads it when somebody presses refresh or a receipt succeeds. It
adds no query parameter, because there are none.

Deferred with the stock read specifically: low-stock thresholds, reserved stock
and available-to-promise, costs and valuation, pagination, server-side search
and filtering, exports, caching, and background refresh. None of them is needed
to answer what is on the shelf today, and several of them would quietly turn an
operational read into a reporting system. Movement history is no longer on that
list — it is `GET /api/inventory/movements`, and it is a separate read for a
separate question rather than a widening of the balances one.

Deferred with stock history specifically: any aggregation or grouping, a running
balance computed across pages, totals by reason or by period, CSV or any other
export, full-text search over notes, filtering by actor, filtering by
`occurredAt`, and any screen that renders any of it. The first several would
turn an evidence read into a reporting engine; the last is PR 7.

Deferred with receiving specifically, and deliberately: suppliers, purchase
orders, invoices, costs, shipment records, receiving statuses, draft receipts,
attachments, lot numbers, expiry dates, serial numbers, barcode scanning, and
CSV import. None of them is a stock movement, and none of them is needed to
record that stock arrived.

Both rules 0005 left to the reversal workflow are now **database constraints**
(0012): a `REVERSAL` must belong to the same chain as the movement it reverses,
and a `REVERSAL` may not itself be reversed. See INV-2.

## Invariants that remain the module's own

- **This is the only module permitted to INSERT into `inventory_movements`.**
  That is the boundary the whole system rests on, and it is enforced by review
  and by `scripts/check-conventions.mjs`, not by the schema. In practice it now
  means: through `postMovement` or `postReversal`, and nowhere else.
- **Merchandise lifecycle is not this module's to decide.** Receiving, removal,
  adjustment, and reversal each ask the catalog the question named after what
  they are about to do, and none of them interprets a status. Nothing here
  changes one, either: a workflow that adjusted a lifecycle to get its own write
  through would be the least inspectable thing in the system.
- Physical counts produce reconciliation movements and never overwrite a
  quantity (INV-9). The engine can post a `COUNT_RECONCILIATION` in either
  direction; the count workflow that decides the delta is deferred.
