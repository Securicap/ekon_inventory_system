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

_Planned:_ the delta is computed server-side from the original row inside the
transaction and is never supplied by the client. A `REVERSAL` cannot itself be
reversed, and it must belong to the same chain as its original — both are
lookups, so they belong to the posting engine.

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

The movement insert, the balance update, the `operations` row, and any audit
event commit in one transaction, or none of them do.

_Enforcement:_ a single `withTransaction` unit of work per command, with
`SELECT ... FOR UPDATE` on the balance row. Implemented for normal movements by
the internal posting engine
(`backend/src/modules/inventory/ledgerService.ts`): the operation claim, the
balance lock or lazy creation, the movement insert, the balance update, and the
operation result all commit together or not at all. The engine is internal —
nothing HTTP reaches it. Audit events join the same transaction when the audit
module lands.

_Verified by:_ `backend/tests/integration/inventoryPostingConcurrency.test.ts`,
which forces transactions to genuinely overlap and checks that writers to one
(variant, location) serialize behind its balance row lock while independent
chains proceed in parallel. The guarantee is PostgreSQL's row-lock semantics at
`READ COMMITTED` on a single database — no retry loop, no isolation change.

## INV-6 — The projection always equals the ledger

For every `(variant, location)`: `quantity_on_hand = SUM(quantity_delta)`.

_Enforcement:_ INV-5 guarantees it at write time, and the posting engine derives
`quantity_before` from the locked balance row rather than by summing the ledger.
_Planned:_ `verify-balances`, run on a schedule, and a property test over
generated movement sequences. Recovery is `rebuild-balances`, which recomputes
the projection from the ledger — always safe, because the ledger is immutable.

## INV-7 — Every command applies at most once

_Enforcement:_ the `operations.id` primary key (0005) plus the posting engine's
`INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`. No row returned means
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

A count line produces a `COUNT_RECONCILIATION` movement of
`counted_quantity - expected_quantity`. `expected_quantity` is snapshotted when
the line is entered, so the recorded discrepancy is what the counter actually
saw. A zero delta records the line and creates no movement.

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
`CHECK (movement_type NOT IN ('ISSUE','ADJUSTMENT_IN','ADJUSTMENT_OUT') OR reason_code IS NOT NULL)`
— `inventory_movements_reason_required` (0008, replacing 0005's adjustment-only
constraint of the same shape). The list mirrors
`REASON_REQUIRED_MOVEMENT_TYPES` in `@ekon/shared`, and an integration test
compares the two. `user_id` is `NOT NULL` but carries no foreign key until
identity exists; a key pointing at a placeholder actor would be worse than
none.

## INV-12 — Rows with history are deactivated, never deleted

_Enforcement:_ `ON DELETE RESTRICT` on every foreign key from
`inventory_movements` and `inventory_balances` onto catalog rows, locations, and
operations (0005). No delete endpoint exists.

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
