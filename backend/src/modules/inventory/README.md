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
- **The stock removal workflow** (`removalService.ts`,
  `domain/removalRequestHash.ts`) and `POST /api/inventory/remove` — ordinary
  stock leaving: sold, damaged, or consumed internally. Posts an `ISSUE`
  movement of a negative delta through the same posting engine, under the new
  `inventory.remove` capability. It is the first thing in the system that takes
  stock _off_ a shelf, and the first workflow that can be refused by the stock
  floor.

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
| Variant not stockable (it or its product is inactive), or location inactive                                 | `409`  | `CONFLICT`                               |
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

**The variant check honours the parent product too**, because the catalog
answers this one:

> A variant is stockable only when both the variant **and its parent product**
> are active.

`findStockableVariant` returns that combined answer as `isActive`, so this
module keeps one simple test — "may I post against this?" — and never learns a
`productIsActive` concept or the order in which the two flags are read. The
current stock read applies the identical rule through
`listStockableVariants()`, so a variant that has stopped being shown as stock
has stopped accepting writes at the same moment, which is the whole point of
letting the catalog own it.

No production path deactivates a product or a variant yet — the catalog creates
and lists, and `catalog.deactivate` has no route or service method — so neither
state can currently arise through the API. The rule is enforced anyway: the
workflow that lands deactivation should be able to set a column and stop, and
the invariant should not be waiting on it to be remembered.

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
| Variant not stockable (it or its product is inactive), or location inactive                                                 | `409`  | `CONFLICT`                               |
| Operation id reused for a different command                                                                                 | `409`  | `OPERATION_REPLAYED_WITH_DIFFERENT_BODY` |
| The shelf does not hold that much                                                                                           | `422`  | `INSUFFICIENT_STOCK`                     |
| Anything unexpected                                                                                                         | `500`  | `INTERNAL`                               |

`422` for a shortfall is the platform's existing mapping for
`INSUFFICIENT_STOCK` and is not special-cased here: the request was well formed
and understood, and the shelf could not satisfy it.

Entity validation goes through `catalogService.findStockableVariant` and this
module's own location table, exactly as receiving's does — same questions, same
statuses, same rules about inactive rows and about authentication preceding
validation. See _What receiving refuses, and with which status_ above; the only
difference is the capability and the extra `422`.

**Removing the last unit is a success.** `quantityAfter: 0` is an answer: the
shelf is empty, not the request refused.

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

Adjustments, physical counts, and public reversal. Reversal posting itself.
Transfers, multi-location stock behaviour, and location management (create /
rename / deactivate). Offline sync remains deferred too.

**Stock adjustment is not implemented**, and removal is not it. `ISSUE` records
stock that left; `ADJUSTMENT_OUT` records a balance that was wrong. The second
has no route, no service, and no workflow — `inventory.adjust` still opens
nothing.

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
