# Ekon Inventory System

Inventory system for a small family retail business in Haiti. Store employees
record stock from a browser on a shared shop laptop; the owner reviews the same
information remotely from another country.

**Status:** Sprint 0 complete. Business capabilities in progress — the `catalog`
module can create and list stockable products with server-generated SKUs
([backend/src/modules/catalog](backend/src/modules/catalog/README.md)), and the
`inventory` module lists inventory locations with one seeded default
([backend/src/modules/inventory](backend/src/modules/inventory/README.md)). The
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

The application is now **usable from a browser**: sign in, stay signed in
through the session cookie, read the catalog and the inventory locations, and
sign out ([frontend](frontend/README.md)). The screens are a temporary shell,
not the platform's visual design — no dashboard, no design system. **Receiving
is next**, and it is the first end-to-end inventory workflow; production
deployment is reviewed after it works.

---

## Getting started

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
sign in with it. The landing screen shows a connected database and the schema
version.

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
  shop laptop (browser)  ─┐
                          ├──▶  one web service  ──▶  managed PostgreSQL
  owner abroad (browser) ─┘     Fastify + React
                                (same origin)
```

The shop laptop is **a client only**. It runs no server, no database, and no
installed software beyond a browser. That is what lets the owner review
inventory from another country without depending on a laptop in Haiti being
switched on.

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
raise on `UPDATE` and `DELETE`, and the application's database role is granted
only `SELECT` and `INSERT`. A mistake is corrected with a compensating movement,
never an edit.

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

## Offline

Offline operation is a real requirement and is the **next major milestone**, not
part of this one. The first release requires connectivity to submit and read
data. What it does guarantee today:

- connectivity failures are clearly visible, never silent;
- forms keep what was typed, in `localStorage`, across a failure or a reload;
- every write carries a retry-stable operation id, so a repeated submission
  cannot duplicate a movement.

Two things the schema already has make that milestone additive rather than a
redesign: identifiers are client-generatable UUIDv7, and every write carries a
retry-stable operation id. Whatever else offline queuing turns out to need will
be designed from real synchronization requirements when the milestone begins,
rather than guessed at now and welded into permanent stock history — see
[ADR 9](docs/07-decisions/0009-user-identity-not-device-identity.md).

One constraint it must respect, recorded now:
`quantity_before`, `quantity_after`, and `previous_movement_id` are assigned by
the server at ingestion, never by the client. A queued offline movement carries
a delta, not a position in the chain.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture decisions and their
reasoning live in [docs/07-decisions/](docs/07-decisions/).
