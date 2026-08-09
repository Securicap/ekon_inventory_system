# Northflank + Supabase staging

This is the concrete hosted staging deployment for Ekon, and it is the one that
has actually been exercised end to end. The generic, provider-neutral procedure
lives in [deployment.md](deployment.md); this document only records how that
procedure is satisfied on Northflank and Supabase.

## Architecture

```text
Browser
  -> HTTPS
Northflank Combined Service
  -> Ekon Docker container
     - React frontend
     - Fastify API
  -> TLS
Supabase Session Pooler
  -> PostgreSQL
```

One container serves both the browser build and the API from a single origin, so
there is one certificate, no CORS, and no cookie-domain problem for the session
cookie. All persistent state is in Supabase; the container holds none.

## Provider status

Northflank's free Developer Sandbox is the environment currently used to prove
the hosted staging workflow. It is not documented here as a production hosting
guarantee, because Northflank makes no such commitment for that plan. Whether
the business runs production on Northflank — and on which plan, with what
availability and backup commitments — remains an operational decision, separate
from this document.

## Northflank service

The staging service is configured as:

- **Combined Service** (build and run in one service);
- source: the GitHub repository `Securicap/ekon_inventory_system`;
- build type: **Dockerfile**;
- build context: the repository root, with the root `Dockerfile`;
- public HTTP port: **8080**;
- region: **US Central** was used for staging.

CI/CD may be pointed at a working branch while staging is being proved. Normal
production deployment should ultimately track the intended release branch rather
than a feature or chore branch.

Nothing else about the service is asserted here. Settings that were not actually
configured and verified — autoscaling, custom domains, resource classes, build
caching — are deliberately not described.

## Container

Build from the repository root:

```bash
docker build -t ekon-inventory .
```

The image uses Node 22, runs the repository's normal `npm run build`
(shared → frontend → backend), and starts `backend/dist/main.js` from
`/app/backend`. Vite writes the browser build into `backend/public`, which
Fastify serves.

The image deliberately retains the migration files and the admin CLI so the
exact deployed revision can also run `npm run migrate` and
`npm run identity:create-owner` as controlled admin commands.

## Environment variables

Set these in the Northflank service's environment:

```text
NODE_ENV=production
DATABASE_URL=<Supabase Session Pooler connection string>
DATABASE_SSL=true
DATABASE_POOL_MAX=5
EXPECTED_SCHEMA_VERSION=0008
APP_VERSION=<release identifier>
DISPLAY_TIMEZONE=America/Port-au-Prince
```

Notes that matter in practice:

- `DATABASE_URL` is an **environment variable holding a secret value**, not a
  secret file. Northflank stores it as an environment variable on the service;
  nothing in the container reads a mounted secret path.
- Store the connection string **without surrounding single quotes**. Quotes are
  shell syntax; an environment variable set through the Northflank UI keeps them
  literally and the connection fails.
- **Do not set `PORT` manually** unless a Northflank configuration requires it.
  The image already sets `PORT=8080` (`Dockerfile`), and public networking
  targets 8080. The application's own default is 3000, so it is the image's
  `ENV` — not the application default — that makes 8080 correct; overriding
  `PORT` without also changing the service's public port breaks routing.
- `EXPECTED_SCHEMA_VERSION` must match the highest migration bundled in the
  deployed revision. Do not copy `0008` forward blindly when a later migration
  is added; production refuses to start when the pin and the database disagree.
- `APP_VERSION` defaults to `dev` when unset, which makes the health endpoint
  report a build identity that is not the deployed one.

Never commit a project ref, password, username, hostname, or connection string
to this repository.

## Supabase

- Supabase is used **only as PostgreSQL**. No Supabase SDK, Auth, Storage, or
  Edge Function is involved; Ekon connects with ordinary PostgreSQL through
  `pg`, using its existing `pg.Pool`.
- Use the Supabase **Session Pooler** connection string, port **5432**, as
  `DATABASE_URL`.
- `DATABASE_SSL=true`, because the pooler requires TLS.
- `DATABASE_POOL_MAX=5` keeps the application's possible connection count small
  against the pooler.
- Migrations are applied with the repository's existing command, run against the
  staging environment: `npm run migrate` (`npm run migrate:status` lists what is
  applied). There is no Supabase-specific migration path.
- Staging currently has migrations `0001` through `0008` applied.

## Health check

The Northflank readiness probe is configured as:

```text
Type: Readiness Probe
Protocol: HTTP
Path: /api/health
Port: 8080
Initial delay: 5 seconds
Interval: 60 seconds
```

`GET /api/health` queries the database before answering, so database
availability decides the result:

- database reachable → **200**, with `status: "ok"`, `database: "up"`, the
  applied `schemaVersion`, and `version` from `APP_VERSION`;
- database unreachable → **503**, with `status: "degraded"`,
  `database: "down"`, and `schemaVersion: null`.

A 503 therefore means the container is running and cannot reach Supabase — a
connection string, TLS, or pooler problem, not a bad build. Because the probe is
a readiness probe, an unavailable database makes the service unhealthy and stops
it receiving traffic.

## Initial owner bootstrap

No migration seeds a user, so a freshly migrated environment has no accounts.
From a shell holding the environment's `DATABASE_URL`:

```bash
read -rs EKON_OWNER_PASSWORD
export EKON_OWNER_PASSWORD

EKON_OWNER_USERNAME=<username> \
EKON_OWNER_DISPLAY_NAME='<display name>' \
npm run identity:create-owner

unset EKON_OWNER_PASSWORD
```

- The angle brackets are **placeholders**. Do not type them literally; replace
  the whole `<...>` with the real value.
- This creates the initial owner **once**. It refuses when an active owner
  already exists, so re-running it cannot produce a second owner account.
- It is **not a password-reset mechanism**. There is no password reset in the
  system, and this command does not provide one. Every account after the first
  is created inside the application by someone holding `identity.manage`.

## Staging acceptance checklist

This is the launch invariant performed by hand against the hosted environment.
It is a checklist, not an automated end-to-end suite, and it was exercised
successfully in this order:

1. `GET /api/health` over public HTTPS is healthy — 200, `database: "up"`,
   `schemaVersion` equal to the pin;
2. bootstrap the owner with `npm run identity:create-owner`;
3. the owner signs in;
4. the owner creates an employee account;
5. the owner creates a product;
6. the owner signs out;
7. the employee signs in;
8. the employee receives stock into a location;
9. current stock shows the correct quantity and location;
10. the employee removes stock;
11. current stock shows the reduced quantity;
12. the employee signs out;
13. authenticated pages are no longer reachable without signing in again.

Do not enter real production inventory while running this exercise.
