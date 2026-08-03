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
make db-reset         # destroy and rebuild the local database
make format           # auto-format
```

## The database

`make db-up` starts PostgreSQL 16 in Docker on port 5432 with user `ekon`,
password `ekon`, database `ekon_dev`. Data persists in a Docker volume across
restarts; `make db-reset` throws it away.

To inspect it:

```bash
docker compose -f infrastructure/docker/compose.yml exec postgres psql -U ekon -d ekon_dev
```

Integration tests do **not** use `ekon_dev`. Each suite creates a throwaway
database, migrates it, and drops it, so tests never interfere with your
development data or with each other.

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

**Frontend build not found — API only** — expected until you run
`npm run build --workspace frontend`. In development you use Vite on 5173
instead, so this warning is harmless.
