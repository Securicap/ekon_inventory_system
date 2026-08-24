# Database invariants

Every invariant states what is guaranteed and **where it is enforced**. An
invariant enforced only in application code is a convention, not an invariant.

Items marked _(planned)_ have their enforcement designed but land with the
module that introduces the table.

## INV-1 — Posted movements are immutable

No row in `inventory_movements` is ever updated or deleted, by any code path.

_Enforcement:_ `BEFORE UPDATE`, `BEFORE DELETE`, and `BEFORE TRUNCATE` triggers
on `inventory_movements` raising `restrict_violation` (0005).
`scripts/check-conventions.mjs` also fails the build on
`UPDATE inventory_movements` or `DELETE FROM inventory_movements` in source.

_Planned:_ the application database role granted only `SELECT, INSERT`, with
migrations run as a separate owner role. A bug, a bad future migration, or a
leaked application credential must not be able to alter posted history. Still
outstanding after 0007: the roles that migration introduces are _application_
roles in a table, unrelated to PostgreSQL roles, and the grant change is an
operations task of its own.

## INV-2 — Corrections are compensating movements

A mistake is corrected by inserting a `REVERSAL` with
`quantity_delta = -original.quantity_delta` and `reverses_movement_id` set, then
a fresh correct movement if needed.

_Enforcement:_ `UNIQUE (reverses_movement_id)` prevents double reversal (0005),
together with CHECKs requiring a `REVERSAL` to name its original, forbidding any
other type from naming one, and forbidding a movement from reversing itself.

0012 adds the two rules 0005 left to the posting workflow, as foreign keys
rather than as conventions:

- **Same chain.** `(reverses_movement_id, variant_id, location_id) → (id,
variant_id, location_id)`, against the unique key 0005 already created for the
  predecessor pointer. A reversal cannot land on a different shelf from the
  movement it names.
- **A `REVERSAL` cannot be reversed.** The original's type is stored beside the
  pointer in `reverses_movement_type` and constrained three ways: the pair is
  complete or both NULL, the recorded type is not `REVERSAL`, and
  `(reverses_movement_id, reverses_movement_type) → (id, movement_type)` proves
  the recorded type is the named movement's real one. The column is a
  constraint's working column, not application data — the same technique 0009
  uses for `product_classifications.dimension_id`.

_Implemented:_ `postReversal` in
`backend/src/modules/inventory/ledgerService.ts` is the only path that writes a
`REVERSAL`. It reads the original inside the transaction and derives the
variant, the location, and the delta from it; the request schema
(`reverseMovementRequestSchema`) refuses all three, so no client can state one.

**A reversal is applied to the _current_ balance, not to the quantity that
followed the original movement.** Reversing a receipt of 10 that has since had 3
issued against it would leave −3, and is refused with `INSUFFICIENT_STOCK`
(INV-8) rather than clamped or partially applied — the later movements are
corrected first. The existence of a historical receipt is not permission to
break the stock floor.

Merchandise lifecycle constrains corrections narrowly and deliberately:
`DISCONTINUED` merchandise can always have its history corrected — discontinuing
something on Friday must not make Thursday's mis-keyed receipt permanent —
while `ARCHIVED` merchandise cannot, because a correction would put stock behind
a status that asserts there is none (INV-19). Restoring it to `DISCONTINUED`
first is explicit, and no workflow ever changes a lifecycle to get its own write
through.

## INV-3 — Before and after quantities are arithmetically consistent

_Enforcement:_ `CHECK (quantity_after = quantity_before + quantity_delta)`, plus
`CHECK (quantity_delta <> 0)` (0005).

## INV-4 — Movement history cannot fork

For each `(variant, location)`, movements form a strict chain.

_Enforcement:_ `previous_movement_id uuid UNIQUE`, plus
`CREATE UNIQUE INDEX ... ON inventory_movements (variant_id, location_id) WHERE previous_movement_id IS NULL`
(0005). Two concurrent transactions claiming the same predecessor collide at the
database; the second fails rather than producing two rows that both claim the
same starting quantity.

The predecessor must also be on the same chain, which a self-referencing
composite foreign key
`(previous_movement_id, variant_id, location_id) → (id, variant_id, location_id)`
guarantees, and a movement cannot name itself as its predecessor. The same
composite key shape points `inventory_balances.last_movement_id` at its own
chain.

## INV-5 — Stock changes are atomic

The movement insert, the balance update, the `operations` row, the count
settlement that accompanies a reconciliation, and any audit event commit in one
transaction, or none of them do.

_Enforcement:_ a single `withTransaction` unit of work per command, with
`SELECT ... FOR UPDATE` on the balance row. Implemented for normal movements by
the internal posting engine
(`backend/src/modules/inventory/ledgerService.ts`): the operation claim, the
balance lock or lazy creation, the movement insert, the balance update, and the
operation result all commit together or not at all. The engine is internal —
nothing HTTP reaches it. Audit events join the same transaction when the audit
module lands.

Count reconciliation is the one workflow that writes something _besides_ the
movement, and it is why `LedgerService` exposes `postMovementInTransaction`
alongside `postMovement`: the engine joins the caller's unit of work rather than
opening a second one, so there is one posting algorithm and no path that can
commit half a reconciliation (INV-9).

_Verified by:_ `backend/tests/integration/inventoryPostingConcurrency.test.ts`,
which forces transactions to genuinely overlap and checks that writers to one
(variant, location) serialize behind its balance row lock while independent
chains proceed in parallel, and
`backend/tests/integration/inventoryCountConcurrency.test.ts`, which forces a
failure between a reconciliation's movement and its settlement and asserts that
neither survives. The guarantee is PostgreSQL's row-lock semantics at
`READ COMMITTED` on a single database — no retry loop, no isolation change.

## INV-6 — The projection always equals the ledger

For every `(variant, location)`: `quantity_on_hand = SUM(quantity_delta)`.

_Enforcement:_ INV-5 guarantees it at write time, and the posting engine derives
`quantity_before` from the locked balance row rather than by summing the ledger.
_Planned:_ `verify-balances`, run on a schedule, and a property test over
generated movement sequences. Recovery is `rebuild-balances`, which recomputes
the projection from the ledger — always safe, because the ledger is immutable.

## INV-7 — Every command applies at most once

_Enforcement:_ the `operations.id` primary key (0005) plus
`INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id` in
`infrastructure/operationRepository.ts` — shared by the posting engine and by
count recording, which claims an operation without posting a movement at all
because a duplicated observation is durable evidence of a shelf-check that never
happened twice. No row returned means
replay: it loads the row, compares `operation_type` and `request_hash`, and
either returns the movement the first attempt posted or fails with `409`
(`OPERATION_REPLAYED_WITH_DIFFERENT_BODY`) if either differs. Never
check-then-insert, which races. A matching operation that records no usable
movement result fails as an internal inconsistency rather than posting a second
movement.

_Client obligation:_ the operation id is generated when the form opens and
reused for every retry, including after a reload. Enforced by
`frontend/src/lib/operations.ts` and its tests. It is the **only** identifier a
caller owns: a retry names the command it repeats, and the engine answers from
the operation's result pointer, so no caller ever has to remember the id of the
movement that command produced. The movement id itself is generated by the
posting engine, and only once the claim has succeeded — a replay mints none.

A canonical request hash therefore covers business fields only. Neither the
movement id nor `recorded_at` is a request field.

## INV-8 — Stock never goes below zero

For any role, by any path.

_Enforcement:_ `CHECK (quantity_on_hand >= 0)` on the balance and
`CHECK (quantity_before >= 0)`, `CHECK (quantity_after >= 0)` on the movement
(0005). The posting engine refuses the movement before inserting it, with
`INSUFFICIENT_STOCK` (422), so the caller gets a meaningful failure; the CHECKs
remain the final protection.

_Rationale:_ a shelf cannot hold minus three items. Systems that permit negative
stock are accommodating out-of-order paperwork, and there is always a correct
alternative: record the missing receipt first, or run a physical count —
`counted_quantity` is what is actually there, which is never negative. There is
deliberately no capability that grants an override.

## INV-9 — Physical counts reconcile, never overwrite

> **A count observes. Investigation explains. Reconciliation changes stock.**

A count line records what somebody physically saw and what Ekon expected at that
moment. It changes no stock. The variance stays visible until somebody with
authority accepts it, and only then does a `COUNT_RECONCILIATION` movement of
`counted_quantity - expected_quantity` post through the ordinary posting engine.
A zero variance records the line and creates no movement — the ledger forbids a
zero delta, and correctly.

The rule this exists to prevent is the one-line version: _counted six, so set
the balance to six_. That destroys the only signal the shop had. Six may be six
because a customer bought one and nobody rang it up, because one broke, because
a delivery was never entered, because somebody mis-keyed a receipt, because the
last one is on another shelf, or because it was stolen — and those are not the
same event.

**The expected quantity is server-owned and permanently snapshotted.** It is
read from `inventory_balances` inside the recording transaction, under a shared
row lock so nothing moves the shelf between the read and the insert; no request
schema accepts one. Movements posted afterwards change today's balance and
change nothing about the count, and no read recomputes the variance against the
current balance.

**Reconciliation applies the observed difference to the current balance**, never
setting it to what was counted. Seven expected, six counted, one legitimately
sold in between: the shelf ends at five, because five is what is actually there.
The stock floor still applies (INV-8) — an old negative variance can become
impossible, and it is refused with `INSUFFICIENT_STOCK` rather than clamped,
reduced, or marked settled without a movement.

**A discrepancy is accepted once, and the acceptance says why.** The reason
comes from a closed vocabulary that deliberately excludes `COUNTING_ERROR`: if
the count itself was wrong then the shelf never differed and there is nothing to
accept — the answer is to count again and record a new observation.

_Enforcement:_ `inventory_count_lines` (0013), and most of it is the schema
rather than the service.

- `variance` and `status` are **generated columns**. The database computes
  `counted_quantity - expected_quantity` and derives `MATCHED` / `OPEN` /
  `RECONCILED` from the variance and whether a reconciliation exists, so three
  numbers cannot disagree and no code path can write a status that contradicts
  them. PostgreSQL rejects any attempt to insert or update either.
- `CHECK ((reconciled_at IS NULL) = (reconciliation_movement_id IS NULL))` — a
  settled count has a movement, and a movement means a settled count. This is
  the atomicity invariant as a row rule.
- `CHECK (counted_quantity <> expected_quantity OR reconciled_at IS NULL)` — a
  match is never reconciled.
- `CHECK (num_nonnulls(reason, reconciled_by, reconciled_at, operation) IN
(0, 4))` — a reconciliation is a complete fact or it is absent.
- `CHECK` on the reason vocabulary, mirrored by `COUNT_RECONCILIATION_REASONS`
  in `@ekon/shared`, plus `OTHER` requiring a note. An integration test compares
  the two sets.
- `UNIQUE (reconciliation_movement_id)` plus two composite foreign keys — onto
  `(id, movement_type)` and `(id, variant_id, location_id)` — so the movement a
  count names is a `COUNT_RECONCILIATION` on the counted shelf, and no second
  count can claim it. `reconciliation_movement_type` is generated, so it cannot
  even be misstated.
- A `BEFORE UPDATE` trigger raising `restrict_violation` on any change to the
  observation (what, where, who, when, expected, counted) and on any change at
  all once the count is reconciled. **The observation is immutable and the
  decision is one-way**: a wrong count is corrected by recording a new one, and
  a wrong decision by reversing its movement (INV-2). Neither rewrites history.
- `COUNT_RECONCILIATION` joins the reason-required movement types
  (`inventory_movements_reason_required`, 0013), so an unexplained reconciliation
  cannot be written by any path.

_Atomicity:_ the movement and the settled count commit in **one transaction**
(INV-5). The count service locks the count row, posts through the ledger's
`postMovementInTransaction` — the same posting algorithm every other workflow
uses, joined to the caller's unit of work rather than opening a second one — and
writes the decision. A count marked reconciled with no movement behind it is a
stock change the shop believes happened and did not; a movement whose count
still reads unresolved is a stock change nobody can explain.

_Concurrency:_ two people accepting one discrepancy contend on the count row's
`FOR UPDATE` lock. One settles it; the other finds it settled and is refused —
except when it is the _same command_ retried, which is answered with the count
it already produced.

_Verified by:_ `backend/tests/integration/inventoryCounts.test.ts`,
`inventoryCountConcurrency.test.ts` (double reconciliation, and a forced failure
between the movement and the settlement), `inventoryCountHistory.test.ts`, and
`countLinesMigration.test.ts`.

_Not stored, and stated so it is not assumed:_ the product name, the brand, the
location name, and the counter's display name on a count read are **current
labels** resolved from the tables that own them today, not snapshots of what
anything was called on the day it was counted. The permanent facts are the ids,
the three quantities, the timestamps, the decision, and the movement
relationship.

## INV-10 — Quantities are integers in whole base units

Never floating point.

_Enforcement:_ `integer` columns, and `scripts/check-conventions.mjs` rejects
`real`, `double precision`, `float4`, `float8`, and `money` in any migration.

## INV-11 — Every movement is fully attributable

`user_id`, `operation_id`, `occurred_at`, and `recorded_at` are all `NOT NULL`.
`reason_code` is required for adjustments **and for issues** — an adjustment
because the number changed without the stock moving, so the reason is the only
account of what happened; an issue because "stock left" is not yet a fact
anybody can act on, and sold, broken, and consumed internally are three
different things. A receipt carries its reason in its type, a count in the
count, and a reversal in the movement it reverses.

**The two reason vocabularies are separate and share only `OTHER`.**
`REMOVAL_REASONS` (`SOLD`, `DAMAGED`, `INTERNAL_USE`, `OTHER`) say why stock
physically left; `ADJUSTMENT_REASONS` (`DATA_ENTRY_ERROR`, `MISSED_MOVEMENT`,
`OTHER`) say why the recorded quantity was wrong. `SOLD` is therefore never an
adjustment reason: a sale nobody recorded is a `MISSED_MOVEMENT`, and a shop
that could not tell those apart could not tell trade from bookkeeping.
A **count reconciliation** has a third vocabulary again
(`COUNT_RECONCILIATION_REASONS`), because it answers a third question: not what
happened to the stock and not why the number was wrong, but why the shop
accepted that the shelf and the record differ. `OTHER` requires a note in both
the adjustment and the reconciliation vocabularies, because it is the one reason
that says nothing on its own. The removal and adjustment vocabularies live only
in `@ekon/shared` so they can grow without a migration; the reconciliation one
is additionally a CHECK on `inventory_count_lines` (0013), because that column
is the stored record of a decision that moved stock.

`occurred_at` is business time — when the stock physically moved — and is stated
by the caller. `recorded_at` is server time — when the posting engine recorded
the event — and is read from the injected clock inside the transaction, never
supplied by a caller and never `now()` in SQL. The two routinely differ, and an
`occurred_at` in the past is a late entry rather than an error.

`user_id` is supplied by the workflow that calls the engine, which is internal
and knows nothing about HTTP. Every future route derives it from
`request.actor.id`; no request schema accepts a user id from the wire.

Attribution is to the person, not the machine. There is deliberately no device,
terminal, session, IP, or user-agent column on a movement: an employee signs in
from whichever computer is free, and which one that was answers no question
about stock. Request metadata belongs in audit and security logging. See ADR 9,
which supersedes that part of ADR 6.

_Enforcement:_ `NOT NULL` constraints plus
`CHECK (movement_type NOT IN ('ISSUE','ADJUSTMENT_IN','ADJUSTMENT_OUT','COUNT_RECONCILIATION') OR reason_code IS NOT NULL)`
— `inventory_movements_reason_required` (0008, replacing 0005's adjustment-only
constraint of the same shape; 0013 adds `COUNT_RECONCILIATION`). The list
mirrors
`REASON_REQUIRED_MOVEMENT_TYPES` in `@ekon/shared`, and an integration test
compares the two. `user_id` is `NOT NULL` but carries no foreign key until
identity exists; a key pointing at a placeholder actor would be worse than
none.

## INV-12 — Rows with history are deactivated, never deleted

_Enforcement:_ `ON DELETE RESTRICT` on every foreign key from
`inventory_movements` and `inventory_balances` onto catalog rows, locations, and
operations (0005). No delete endpoint exists.

For merchandise, "deactivated" now means a **lifecycle status** and nothing
else. `products.is_active` and `product_variants.is_active` were dropped by
0012, and `lifecycle_status` is the sole authority — one notion of withdrawn
rather than two adjacent ones that get checked in different places. See INV-19
for what each status permits. `users.is_active` (INV-16) and
`inventory_locations.is_active` (0004) are untouched: whether a person may sign
in and whether a shelf is open for business are different facts about different
things, and neither is merchandise lifecycle.

## INV-13 — SKUs are unique and immutable

_Enforcement:_ `UNIQUE (sku)` and a `BEFORE UPDATE` trigger raising
`restrict_violation` on any change to the column, both in 0002. SKUs are printed
on physical shelf labels; changing the format after labels exist is a
physical-world migration.

**A barcode does not replace a SKU, and never will.** `variant_barcodes` (0009)
holds external identifiers attached to a variant — a manufacturer's or
distributor's code, which may be absent, may be reused across unrelated goods,
may change between production runs, and may exist several at a time for one
item. None of that is true of the SKU, which is why the SKU stays the system's
own handle on a variant and a barcode is an alternate lookup key onto it.

Uniqueness there is deliberately weaker, and the weakness is the point: a
barcode is unique **per variant**, not globally. A global unique index would
assert a guarantee the world does not honour, and the first time two genuinely
different items shipped under one code the database would refuse to record the
truth.

## INV-14 — A credential is never stored in a form it can be read back from

`users.password_hash` holds an Argon2id hash, and `sessions` stores only the
hash of a session token — never the token the browser holds. A stolen database
backup yields no password and no usable session.

_Enforcement:_ split deliberately between the two layers.

The **database** guarantees the structure of the column and nothing about its
contents: `password_hash` is nonblank, stored trimmed, and bounded at 512
characters (0007). It does not attempt to recognize an Argon2 string. A CHECK on
the encoding would make the schema an authority on which algorithm is correct —
a claim it cannot keep, since it would need migrating in lockstep with any
algorithm change and would forbid the interim state where old and new hashes
coexist while accounts rehash on sign-in.

The **application** guarantees what goes in it. `hashPassword` in
`backend/src/modules/identity/domain/password.ts` is the only function in the
system that produces a stored credential, it hashes with Argon2id, and it is the
only path any caller has. Its unit tests assert the produced value is an Argon2id
PHC string, is never the plaintext, and differs on every call.

`sessions` has no column that could hold a raw token, a refresh token, or a
session payload. The backend never logs a credential: `req.body.password` and
its siblings are redacted in `backend/src/app.ts`, and the password utility keeps
plaintext out of its own error messages — both asserted by tests.

_Rationale:_ this is the one class of data where "we are careful about it" is
not good enough, because the cost of being wrong is every account in the
business plus whatever else those passwords were reused for. The protection that
matters is that there is exactly one way to write the column and it hashes;
a constraint restating today's algorithm would add a migration to every future
credential change without narrowing that path any further.

## INV-15 — A user's current role decides what they may do, right now

Capabilities are resolved from `users.role` through `role_capabilities` on every
request. A session carries no snapshot of them.

_Enforcement:_ `sessions` has no capability, role, or permission column (0007),
so there is nothing to resolve against except the user's current row. Changing
a role or setting `is_active = false` therefore lands on the very next request,
without rewriting a single session row.

_Enforcement (planned):_ the `onRequest` hook that reads the session, loads the
user, and refuses an inactive one. That arrives with the login route; until it
does, no route is enforced at all.

## INV-16 — A user with history is deactivated, never deleted

Their name has to stay readable on every movement they posted.

_Enforcement:_ `sessions.user_id` references `users` with `ON DELETE RESTRICT`
(0007), and `users` has `is_active` rather than a `deleted_at` — one notion of
"gone", not two subtly different ones that get checked in different places. The
same rule as INV-12, applied to people.

_Planned:_ the foreign key from `inventory_movements.user_id` to `users`, which
would make this bite on the ledger too. It is deliberately not in 0007: existing
movements carry arbitrary test actor UUIDs, and how permanent history gets
connected to real users is a decision the authentication series makes on its own
terms rather than smuggling into the migration that first creates `users`.

## INV-17 — A stored amount is minor units and a currency, or it is nothing

Money is never a float, never a bare number, and never half-stated. A variant's
selling price and its reference cost are each a `bigint` count of minor units
plus an explicit uppercase three-letter currency code, and either both columns
of a pair are set or neither is.

_Enforcement:_ `bigint` columns, `CHECK (amount IS NULL OR amount >= 0)`,
`CHECK ((amount IS NULL) = (currency IS NULL))`, and
`CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')` on
`product_variants.selling_price_*` and `product_variants.reference_cost_*`
(0009). `scripts/check-conventions.mjs` additionally rejects `real`,
`double precision`, `float4`, `float8`, and `money` in any migration.

The currency check is a **shape and not a list**. Which currencies the business
accepts is an operational question, and a list committed to the schema would
turn accepting one more into a migration. Price and cost carry separate
currencies because this shop routinely buys in one and sells in another.

_Rationale:_ `NULL` means nobody has established the amount yet, which is the
state every variant that predates 0009 is in. Zero would mean the item is free,
or cost nothing to acquire. Backfilling zeroes to avoid a nullable column would
have replaced an honest absence with a number that reports as fact.

**`reference_cost_*` is not inventory valuation.** It is one mutable figure per
variant, overwritten the next time the shop buys the same item at a different
price, and it does not know which units on the shelf came from which purchase.
Nothing may read it and call the result profit. Historical costing needs cost
carried on receipts and consumed by depletions — a ledger change, and post-OR1
work.

## INV-18 — A new variant attribute uses a name the catalog has defined

`variant_attributes.attribute_name` must exist in
`variant_attribute_definitions.name`. An attribute name is structure, not data:
it is what `variant_signature` is built from, so a catalog that grows `color`,
`colour`, and `couleur` can never be reported on again.

_Enforcement:_ `variant_attributes_name_defined_fk` (0010), a foreign key onto
the definition's **name** rather than its id — the name is already the identity,
so the natural key states the relationship that is there instead of
manufacturing a second one. `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`: a
definition in use cannot be removed, and renaming `color` would rewrite the
identity of every variant carrying one. The catalog service checks the same rule
first so a caller gets a field-level message naming what it may use, but the
check is the message and the key is the guarantee.

**Scope, stated exactly: the key is `NOT VALID`.** PostgreSQL enforces it on
every insert and update, and does not check rows that were already stored. Both
halves are deliberate. Every new write is controlled by the database rather than
only by a service check somebody could forget to call; and every attribute
written before any vocabulary existed keeps its name, its value, and its place
in its variant's signature. A migration that refused to apply over such a row
would block a deploy over data nobody has reviewed, and one that renamed it
would change which variant the row identifies and orphan the inventory history
keyed to it.

This is not the `NOT VALID` that 0008 declined. There it would have skipped a
scan over rows already known to be good, buying a shorter lock in exchange for a
window in which the ledger accepted unchecked values. Here the existing rows are
genuinely unverified and must stay, so `NOT VALID` is not a deferral of the check
but a statement of its exact scope.

_When full enforcement becomes possible:_ once every distinct name in
`variant_attributes` has a definition — an operator task of reading them,
deciding which are real merchandise attributes, and defining those. It completes
with `ALTER TABLE variant_attributes VALIDATE CONSTRAINT
variant_attributes_name_defined_fk`, which scans without locking writers out and
leaves an ordinary fully-valid key. A fresh installation has nothing to review
and would pass it today; no migration runs it, because a migration cannot know
which installation it is on.

Attribute **values** are deliberately not controlled. `Black` is display text,
normalized for identity and stored with its case preserved (0003); a controlled
option set for every attribute of every kind of merchandise is the
over-engineering trap this schema has avoided twice already.

## INV-19 — Merchandise lifecycle governs what may be done, and archived merchandise holds no stock

`ACTIVE → DISCONTINUED → ARCHIVED`, on both `products` and `product_variants`,
with `DISCONTINUED → ACTIVE` and `ARCHIVED → DISCONTINUED` as the corrective
steps back. A variant's **effective** status is the more restrictive of its own
and its parent product's, derived rather than propagated — withdrawing a product
does not rewrite its variants' rows, so restoring it restores exactly what it
withdrew.

| effective status | receive | issue | count | correct | current stock | history |
| ---------------- | ------- | ----- | ----- | ------- | ------------- | ------- |
| `ACTIVE`         | yes     | yes   | yes   | yes     | shown         | shown   |
| `DISCONTINUED`   | **no**  | yes   | yes   | yes     | **shown**     | shown   |
| `ARCHIVED`       | no      | no    | no    | no      | not shown     | shown   |

**A quantity reaching zero is not a lifecycle change**, and nothing in this
system promotes one into the other. Selling the last unit is a fact about a
shelf; discontinuing is a decision about merchandise (ADR 11).

**`DISCONTINUED` merchandise stays operationally visible.** That is the whole
content of the status: replenishment stops, trading does not. Hiding it would
strand stock the business owns and is still selling, and stranded stock leaves
the shelf anyway — with the ledger the only thing that does not know.

**Archiving requires zero stock**, across every location, and for a product
across every one of its variants. Archived merchandise leaves the day-to-day
stock view, which is honest only because there is nothing left on a shelf to
hide.

_Enforcement:_ this one is application-and-lock, not a CHECK, and the boundary
is worth stating exactly. A cross-table aggregate ("this variant's balances sum
to zero") is not expressible as a row constraint, and a trigger that read the
catalog on every balance update would put a cross-module read on the hot path of
every movement in the system.

What makes it hold is a **lock protocol both sides observe**, in one fixed
order — `products`, then `product_variants`, then the balances:

- a lifecycle change (`backend/src/modules/catalog/lifecycleService.ts`) takes
  `FOR UPDATE` on the merchandise rows and only **then** reads the balances,
  through the inventory module's narrow `StockPresenceReader` port;
- every posting workflow takes `FOR SHARE` on the same rows inside its posting
  transaction, before it touches a balance, through
  `CatalogService.findVariantFor{Receiving,Issue,Correction}`.

So an archive and a movement cannot cross unnoticed: whichever gets the
merchandise row first commits, and the other sees it and is refused. They
contend on the **catalog** row rather than the balance row, which matters
because a shelf that has never held stock has no balance row to contend for —
exactly the case an archive is most likely to meet. `READ COMMITTED`, no retry
loop, no advisory lock, and no in-memory mutex (which would protect one process,
and this system will not always be one process).

_Verified by:_
`backend/tests/integration/catalogLifecycleConcurrency.test.ts`, which stages
both directions behind a barrier that asks PostgreSQL itself whether the
commands are really blocked, and
`backend/tests/integration/catalogLifecycle.test.ts` for the matrix and the
per-status behaviour.

_Limitation, stated rather than worked around:_ **a lifecycle change records no
actor and no history.** The status and `updated_at` are persisted and the
capability is enforced, but nothing says who withdrew a product or when it was
last restored. That belongs in `audit_events`, and the audit module does not
exist yet — building a general audit subsystem for this one workflow would be a
larger project than the workflow. Until it lands, a lifecycle change is
attributable only through the application log.
