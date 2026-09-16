# Local development

## First run

```bash
make setup
make dev
```

Backend on <http://localhost:3000>, frontend on <http://localhost:5173>. The
frontend proxies `/api` to the backend, so you always use port 5173 in the
browser.

## Everyday commands

```bash
make dev              # watch mode, both sides
make test             # everything (needs the database up)
make test-unit        # only tests that do not need a database
make check            # what CI runs: types, lint, conventions, tests
make migrate          # apply pending migrations
make migrate-status   # what is applied and what is not
make db-app-user      # create the restricted role the application connects as
make db-reset         # destroy and rebuild the local database
make format           # auto-format
```

Operating an installation — backing up, restoring, diagnostics — is `ekon-ctl`.
The same code runs here through npm:

```bash
npm run ekon-ctl -- help
npm run ekon-ctl -- backup --tag before-upgrade
npm run ekon-ctl -- restore-drill <file>
```

It needs `EKON_BACKUP_DIR` and `EKON_STATE_DIR` set, and `pg_dump`/`pg_restore`
on `PATH` (or `EKON_PG_BIN` pointing at them). See
[backend/src/cli/README.md](../../backend/src/cli/README.md).

## The database

`make db-up` starts PostgreSQL 16 in Docker on port 5432 with user `ekon`,
password `ekon`, database `ekon_dev`. Data persists in a Docker volume across
restarts; `make db-reset` throws it away.

Set `EKON_DB_PORT` if something else on your machine already has 5432:
`EKON_DB_PORT=5433 make db-up`, and point `DATABASE_URL` at the same port. Only
the published port changes; the container still listens on 5432.

**Two database roles.** `ekon` owns the tables and is what migrations and the
test setup use. `ekon_runtime` is what the _application_ connects as: a login
role in `ekon_app`, which migration 0014 grants `SELECT, INSERT` on
`inventory_movements` and no more — so a bug, a bad migration, or a leaked
connection string cannot alter posted history. `make db-app-user` creates it and
is run by `make setup` and `make db-reset`; a volume created before 0014 needs it
once, by hand.

To inspect it:

```bash
docker compose -f infrastructure/docker/compose.yml exec postgres psql -U ekon -d ekon_dev
```

Integration tests do **not** use `ekon_dev`. Each suite creates a throwaway
database, migrates it, and drops it, so tests never interfere with your
development data or with each other. Each suite gets **two** connections to it:
the owner, for migrations and fixtures, and the restricted application role,
which is what every test that builds the application passes to `buildApp`. A code
path that needs a privilege nobody granted therefore fails in CI rather than at a
counter.

## Adding a migration

1. Create `backend/migrations/NNNN_short_description.sql`, numbered after the
   last one.
2. `make migrate`.
3. `make migrate-status` to confirm.

Never edit a migration that has been merged — the runner checksums applied
migrations and will refuse to start. Write a new forward one.

## Troubleshooting

**`DATABASE_URL is required`** — no `.env`. Run `cp .env.example .env`.

**`ECONNREFUSED 127.0.0.1:5432`** — the database is not running. `make db-up`.

**`Schema version mismatch`** — the code expects a migration the database does
not have. Run `make migrate`.

**`Migration NNNN has changed since it was applied`** — a merged migration was
edited. Restore it and write a new one. If it is your own local-only migration,
`make db-reset`.

**Tests fail with "database does not exist"** — the test helper creates
databases, which needs the `ekon` role to have `CREATEDB`. The Docker image
grants it; a hand-rolled local Postgres may not.

**Port 3000 or 5173 in use** — change `PORT` in `.env`, or stop the other
process.

**`permission denied for table …` in a test** — the application connects as the
restricted role. If the statement is the application's own work, migration 0014
is missing a grant; if it is a test asserting a trigger or a constraint, use
`db.pool` (the owner) rather than `db.appPool`.

**A backup or restore-drill test is skipped** — `pg_dump` and `pg_restore` are
not on `PATH`, which is normal when the database runs in Docker. Install
`postgresql-client-16` to run them, or leave it to CI, which installs it and
fails rather than skipping.

**Frontend build not found — API only** — expected until you run
`npm run build --workspace frontend`. In development you use Vite on 5173
instead, so this warning is harmless.
