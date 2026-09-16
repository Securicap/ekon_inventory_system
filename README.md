# Ekon Inventory System

Inventory system for a small family retail business in Haiti. It is installed
on the shop's own computer and used from a browser there: the application and
its PostgreSQL database both run on that machine, and the shop can record stock
with no internet connection at all. See
[ADR 13](docs/07-decisions/0013-local-first-shop-installation.md).

**Status:** Sprint 0 complete. Business capabilities in progress — the `catalog`
module can create and list stockable products with server-generated SKUs
([backend/src/modules/catalog](backend/src/modules/catalog/README.md)), and the
`inventory` module lists inventory locations, holds the append-only movement
ledger, **records stock arriving** — `POST /api/inventory/receive` books in one
variant at one location, through the posting engine, with retries that apply
once — **answers what is on the shelf**: `GET /api/inventory/balances` returns
every active variant and its quantity at every active location, read from the
balance projection, including the variants nobody has booked anything in against
yet — and now **records stock leaving**: `POST /api/inventory/remove` posts an
`ISSUE` for a positive quantity that was sold, damaged, or used internally,
under the new `inventory.remove` capability, refused with `INSUFFICIENT_STOCK`
rather than clamped when the shelf cannot cover it
([backend/src/modules/inventory](backend/src/modules/inventory/README.md)).
**Stock leaving is not stock being corrected:** `ISSUE` says the stock genuinely
went, `ADJUSTMENT_OUT` says the recorded balance was wrong, and they are
separate workflows under separate capabilities —
`POST /api/inventory/adjust` corrects a recorded quantity under
`inventory.adjust`, and `POST /api/inventory/reverse` undoes one wrong movement
by appending a compensating `REVERSAL` under `inventory.reverse`, never by
editing history. `SOLD` is a removal reason and nothing more — there is no sale,
customer, price, or payment anywhere in this system. Merchandise now carries an
authoritative **lifecycle** — `ACTIVE → DISCONTINUED → ARCHIVED`, set through
`PATCH /api/catalog/{products,variants}/:id/lifecycle` under
`catalog.deactivate` — which decides what may be received, issued, counted, and
corrected; discontinued stock stays visible and sellable, and merchandise
holding stock cannot be archived. And the shop can now **count what is actually
on the shelf**: `POST /api/inventory/counts` records what somebody saw against
what Ekon expected and changes no stock, the variance stays visible until
somebody accepts it, and
`POST /api/inventory/counts/:countId/reconcile` posts the one
`COUNT_RECONCILIATION` that carries it — **a count observes, investigation
explains, reconciliation changes stock.** The
`identity` module holds the users, sessions, and role-capability schema, the
first-owner bootstrap command, and now **session authentication** — sign in,
sign out, and `GET /api/auth/me`, behind an http-only cookie carrying an opaque
server-side session
([backend/src/modules/identity](backend/src/modules/identity/README.md)).
Those sessions now **protect the API**: every route under `/api/` declares
whether it is public, authenticated-only, or capability-protected, an
application that omits a declaration refuses to start, and the catalog and
inventory routes are enforced — `401` without a session, `403` without the
capability.

The application is now **usable from a browser**, and the first inventory loop
is closed: sign in, read the catalog, **book in a delivery** — one item, one
location, one quantity, one arrival time — **read what is on the shelf**, and
sign out ([frontend](frontend/README.md)). A retry after a dropped connection
books the stock once, because the browser sends the same operation id rather
than a new one. The Stock screen reads `GET /api/inventory/balances` behind
`inventory.read` and shows every active variant with its total and its quantity
at each active location, zeroes included; a confirmed receipt marks that read
stale so the next look at it asks the server again. It searches in the browser
over what the server already sent, refreshes only when somebody presses the
button — there is no polling — and shows no movement history.

The **Removal screen** closes the operating loop, behind `inventory.remove`,
which every role holds including `EMPLOYEE`: choose an item, choose the shelf it
left from, see what that shelf holds, say how many and why — sold, damaged, used
internally, or other — and record it. It reads the same balance response Stock
does, and shows what each shelf holds so nobody guesses; those numbers are
advisory, and the server still refuses a removal the shelf cannot cover, which
the screen renders as its own state rather than trying to prevent. A retry after
a dropped connection removes the stock once. A confirmed removal refreshes the
current-stock numbers everyone reads.

The screens are a temporary shell, not the platform's visual design — no
dashboard, no design system. Adjustment, reversal, lifecycle control, stock
history and **physical counts** are all **API only**: every screen for them is
PR 7.

## Where this is going

Everything above describes **what the software does today**. It is not the
architecture it is being built into, and the difference matters to anybody
reading the code for the first time.

Ekon is becoming a **retail merchandise and inventory operations system**: a
product carries a brand and a classification as structured data, a variant/SKU
is the smallest sellable and stockable identity and owns its own price, cost,
stock, and history, and a physical count is reconciled through the ledger rather
than typed over a balance. The merchandise model, its lifecycle, and safe corrections have since landed;
today's generic `Remove → SOLD` has not changed, and it records that stock left
rather than being a sales design.

The milestone that direction is aimed at is **OR1**: safe and useful enough to
become the store's real day-to-day inventory system while development continues.
OR1 is delivered as **Ekon Local v1** — an installation on the shop computer,
with a bundled local PostgreSQL 16, both tiers bound to `127.0.0.1`, and no
internet required to operate. Hosted staging once passed its own launch
invariant for the loop described above; that was a tested baseline for the
earlier model on a deployment target that no longer applies, and it is not OR1.

What is unchanged, and is the foundation the rest is built on: the append-only
movement ledger, balances as a projection, operation-id idempotency,
server-owned before/after quantities, and immutable generated SKUs.

Read [docs/03-architecture/retail-domain-and-or1.md](docs/03-architecture/retail-domain-and-or1.md)
before changing the merchandise model. The decisions are
[ADR 11](docs/07-decisions/0011-retail-merchandise-and-inventory-operations.md),
[ADR 12](docs/07-decisions/0012-operational-release-one.md), and
[ADR 13](docs/07-decisions/0013-local-first-shop-installation.md).

---

## Getting started

**This is the developer setup, and only that.** It runs the two sides in watch
mode against a Docker PostgreSQL, which is not how a shop runs Ekon — production
is an installation on the shop computer, described in
[ADR 13](docs/07-decisions/0013-local-first-shop-installation.md). There is no
installer yet.

You need [Node.js 22](https://nodejs.org) and Docker. Then:

```bash
git clone https://github.com/Securicap/ekon_inventory_system.git
cd ekon_inventory_system
make setup      # installs dependencies, creates .env, starts Postgres, migrates
make dev        # backend on :3000, frontend on :5173
```

Open <http://localhost:5173>. You will be asked to sign in. A new database has
no accounts at all — create the first owner once, with
`npm run identity:create-owner` (see
[backend/src/modules/identity](backend/src/modules/identity/README.md)), then
sign in with it. Every account after that one is created from inside the
application, by somebody holding `identity.manage`: the owner opens **Nouvo
kont** and gives each employee a username, a name, a password, and a role. The
landing screen shows a connected database and the schema version.

`make help` lists every command.

| Command         | What it does                                               |
| --------------- | ---------------------------------------------------------- |
| `make setup`    | One-time setup: dependencies, `.env`, database, migrations |
| `make dev`      | Run backend and frontend in watch mode                     |
| `make test`     | Run all tests (needs the database running)                 |
| `make check`    | Everything CI runs: types, lint, conventions, tests        |
| `make migrate`  | Apply pending migrations                                   |
| `make db-reset` | Destroy and rebuild the local database                     |
| `make build`    | Production build                                           |

If something does not work, see [docs/06-operations/local-development.md](docs/06-operations/local-development.md).

---

## How the pieces fit together

```
  the shop computer
  ┌──────────────────────────────────────────────────────┐
  │  browser  ──▶  one web service  ──▶  PostgreSQL 16   │
  │  127.0.0.1     Fastify + React       127.0.0.1:5432  │
  │                (same origin)         local, bundled  │
  └──────────────────────────────────────────────────────┘
        nothing listens outside the machine · no internet needed
```

Everything the shop uses is **on the one computer**: the application and the
database are installed there, both bound to the loopback interface, so an
outage — of the internet, of any provider — cannot stop somebody recording what
arrived or what left. Backup and restore are therefore part of the product
rather than a provider's job. Remote review for the owner, who is in another
country, is a later milestone; it is not in v1.

| Directory             | Contains                                                                    |
| --------------------- | --------------------------------------------------------------------------- |
| `shared/`             | Types, Zod schemas, capability and movement vocabularies used by both sides |
| `backend/`            | Fastify modular monolith; also serves the built frontend                    |
| `backend/migrations/` | Sequential `.sql` migrations, applied in filename order                     |
| `frontend/`           | React + TypeScript, built into `backend/public`                             |
| `infrastructure/`     | Local development Docker compose                                            |
| `scripts/`            | Convention and bundle-budget checks                                         |
| `docs/`               | Architecture, database, operations, decision records                        |

The backend is a **modular monolith**: one process, one deployment, with
internal module boundaries that ESLint enforces. Modules are `identity`,
`catalog`, `inventory`, and `audit`, over a shared `platform` layer. Each module
has a README describing what it owns.

---

## The rules that matter

These are not style preferences. They are the reasons the business can trust its
own numbers, and most of them are enforced by the database or by CI rather than
by review.

**Inventory history is append-only.** `inventory_movements` is never updated or
deleted — not by a bug, not by a migration, not by a leaked credential. Triggers
raise on `UPDATE` and `DELETE`. A mistake is corrected with a compensating
movement, never an edit.

**Every movement records what the quantity was and what it became.** Each row
carries `quantity_before` and `quantity_after`, with a database CHECK that they
agree with the delta, and a `previous_movement_id` chain that makes it
impossible for two concurrent writers to both claim the same starting quantity.
Balances are therefore reconstructable from the ledger alone.

**Balances are a projection, never the truth.** `inventory_balances` is updated
in the same transaction as the movement insert. It exists so screens are fast,
and it can always be rebuilt from the ledger.

**Stock can never go below zero.** By any path, for any role. A shelf cannot
hold minus three items. If an adjustment would go negative, the missing receipt
is recorded first, or a physical count establishes the truth.

**Every write is idempotent.** The browser generates an operation id when a form
is opened — not when it is submitted — and reuses it for every retry, including
after a page reload. Submitting the same operation twice produces one movement.

**Quantities are integers in whole base units.** Never floating point. CI
rejects `real`, `double precision`, and `money` in migrations.

**Nothing is deleted once it has history.** Products and variants are
deactivated.

Full detail: [docs/04-database/invariants.md](docs/04-database/invariants.md).

---

## Working without internet

Offline was a milestone when the database lived somewhere else. Under
[ADR 13](docs/07-decisions/0013-local-first-shop-installation.md) the shop's
data is on the shop's computer, so every workflow already works with the
connection down and there is nothing to queue against. What is left for a later
milestone is **synchronization** — a copy the owner can read from abroad — and
it gets its own decision.

What the software guarantees today, and what a sync milestone would build on:

- connectivity failures are clearly visible, never silent;
- forms keep what was typed, in `localStorage`, across a failure or a reload;
- every write carries a retry-stable operation id, so a repeated submission
  cannot duplicate a movement.

Two things the schema already has make that milestone additive rather than a
redesign: identifiers are client-generatable UUIDv7, and every write carries a
retry-stable operation id. Whatever else synchronization turns out to need will
be designed from real requirements when the milestone begins, rather than
guessed at now and welded into permanent stock history — see
[ADR 9](docs/07-decisions/0009-user-identity-not-device-identity.md).

One constraint it must respect, recorded now:
`quantity_before`, `quantity_after`, and `previous_movement_id` are assigned by
the server at ingestion, never by the client. A movement arriving from elsewhere
carries a delta, not a position in the chain.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture decisions and their
reasoning live in [docs/07-decisions/](docs/07-decisions/).
