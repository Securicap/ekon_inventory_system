# Deployment

## Status

Ekon is deployed to **staging**: the application runs on Northflank, and its
PostgreSQL is hosted by Supabase. What made that worth doing is that the
operating loop a shop needs on its first day is closed end to end, so the
deployment put a real database behind an application people can actually work
in.

The launch invariant below has been exercised successfully, by hand, against
that hosted staging environment. Provider-specific setup — the service, its
environment variables, the readiness probe — lives in
[northflank-supabase.md](northflank-supabase.md); this document stays
provider-neutral.

**Production is not declared live.** Staging runs on Northflank's free Developer
Sandbox, which is what proved the hosted workflow and not an approved permanent
production environment.

**Nor is production OR1.** Going live is now defined as the OR1 milestone in
[retail-domain-and-or1.md](../03-architecture/retail-domain-and-or1.md) and
[ADR 12](../07-decisions/0012-operational-release-one.md): safe and useful
enough to become the store's real day-to-day inventory system. The launch
invariant below is the **tested staging baseline for the operating loop this
document describes**, and it passed. OR1's acceptance gate is broader — a
corrected merchandise model, history visibility, safe corrections, basic count
and reconciliation, lifecycle control, and production data preservation on top
of what is here — and it is exercised in PR 8. Nothing in this document is
retracted by that; it simply is not the same gate.

An **infrastructure candidate** exists: Ekon on a single Oracle Cloud Always
Free VM, with Caddy in front, self-hosted PostgreSQL on an attached block
volume, and a nightly backup to Object Storage. Its tooling and runbook are in
[oci-zero-cost.md](oci-zero-cost.md). It is a _candidate_: it would earn
production status only after every box in that document's acceptance checklist
is ticked — deployment, backup, an off-VM copy, a passing restore drill,
monitoring, and the launch invariant performed on the shop's own hardware. Until
then no real inventory is entered into it.

**It is one option, not the plan of record, and OR1 does not depend on it.**
Roughly $20 has been set aside for hosting, so a paid managed platform is an
equally legitimate choice and zero-cost infrastructure is not a requirement. The
OR1 host is chosen in PR 8, against the acceptance gate and the budget, and is
deliberately not chosen here.

Following this document gives the business exactly this, and nothing more:

- **owner bootstrap** — one command creates the first account on a new
  installation, once;
- **sign in and sign out**, with server-side sessions that a revocation ends on
  the next request;
- **employee accounts created by the owner** from inside the signed-in
  application;
- **capability authorization** — every API route declares what it requires, and
  a route that declares nothing refuses to start;
- **the product catalog** — an owner or manager holding `catalog.write` creates
  products and their variants from the browser;
- **receiving stock**;
- **current stock, by location**;
- **removing stock**;
- **retry-safe posting** — a receipt or a removal retried after a dropped
  connection posts once.

### The launch invariant

> After the bootstrap, the owner can sign in, create employee accounts, and
> create the first product; an employee can then receive it, see its stock and
> location, remove it, and sign out — **all through supported application
> workflows, with no API call, database statement, or shell command anywhere in
> the sequence.**

That sentence is what "ready to deploy" means here, and the first-deploy
procedure below is it, performed once against a real environment. The handoff in
its middle — a product created in the browser becoming something an employee can
book in — is asserted in
`frontend/tests/catalog/outcomes.test.tsx`.

It proved this loop, against this product model, and it keeps that credit. It is
**not** the OR1 gate, which covers the merchandise model that replaces the one
above.

There are no adjustments, no counts, no transfers, no suppliers or purchasing,
no sales, no reports, and no audit log. Products cannot yet be edited, renamed,
or deactivated, and a variant cannot be added to a product that already exists;
a product created wrongly is replaced by creating the right one. Accounts cannot
be listed, edited, deactivated, or given a new password, and there is no
password reset.

## Shape

One managed web service and one managed PostgreSQL database. Nothing runs in
the shop.

Region is a latency decision for Haiti, and this document does not fix one: a US
East region is the natural choice wherever a provider offers it. That is not
where staging is today — the Northflank staging service runs in **US Central
(Council Bluffs)**.

The web service serves the API _and_ the built frontend from one origin, so
there is one deploy, one certificate, no CORS, and no cookie-domain problem for
the session cookie. There is no separate frontend host.

This document names no platform's commands, so it holds for whatever production
is eventually run on. Where it says "the platform builds" or "the release
command", that is a setting to fill in for the service in question;
[northflank-supabase.md](northflank-supabase.md) fills them in for staging.

## Environments

| Environment  | Where                                      | Purpose                                                                                  |
| ------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| development  | Local, and CI                              | Building and testing                                                                     |
| `staging`    | Northflank + Supabase                      | Proves migrations against a copy of production's schema before real inventory is touched |
| `production` | **Not declared live; host not yet chosen** | The business's records, from OR1 onward                                                  |

A release moves left to right: green in CI, proven on staging, then deployed by
exact commit SHA to whatever production turns out to run on.

The OCI Always Free stack in [oci-zero-cost.md](oci-zero-cost.md) is a
**candidate for that host**, with working tooling and its own acceptance
checklist; a paid managed platform within the ~$20 hosting budget is an equally
legitimate candidate. Either way, production is declared live only when OR1's
gate passes — not when the tooling exists, and not by a host being reachable.

## What is already true, and what a deployment must still provide

The distinction matters when reading the rest of this document: a guarantee the
application enforces is one nobody can forget, and everything else is somebody's
job.

**Enforced by the application, on every boot and every request:**

- configuration is parsed and validated once, at boot; a missing or malformed
  value is a startup failure naming every problem at once, not a 500 later;
- with `NODE_ENV=production`, **`EXPECTED_SCHEMA_VERSION` is mandatory** — a
  production build cannot start without a schema pin, so it cannot silently
  serve traffic against whatever version the database happens to be at;
- when the pin is set, the process refuses to start unless the database's
  highest applied migration equals it;
- migrations run one per transaction, are checksummed against the files that
  were applied, and re-running them applies nothing;
- `GET /api/health` reports the database's reachability, the applied schema
  version, and the build identity, and answers `503` when the database is down;
- every response carries an `x-request-id`, and every error body repeats it;
- logs are structured JSON in production, with cookies, authorization headers,
  and password fields removed before a line is written;
- the session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` whenever
  `NODE_ENV=production`;
- every `/api/` route declares whether it is public, authenticated, or
  capability-protected, and one that declares nothing prevents the application
  from starting.

**Configured during deployment, and not visible to the application:** TLS
termination in front of the service; the managed database and its TLS; the
environment variables below; running migrations as a release command before the
new instance takes traffic; backup schedule and retention; log retention and
wherever logs are read; any alerting.

**Performed by a person, once or on a schedule:** the owner bootstrap; the
first-deploy verification below; the restore drill; a rollback, if one is ever
needed.

## First deploy

Do these in order. Step 3 is the only one that can never be repeated; steps 7
and 8 are done once here and afterwards whenever the shop hires somebody or
stocks something new.

### 1. Configure the environment

Provision the database and the web service, then set the environment variables
listed under [Environment variables](#environment-variables). Nothing is read
from a committed file in production.

### 2. Run migrations

The release command, before the new instance takes traffic:

```bash
npm run migrate
```

Each migration runs in its own transaction. A failure aborts the deploy, and on
a first deploy there is no previous instance to keep serving — the environment
simply stays empty, which is the right outcome. `npm run migrate:status` lists
what is applied.

### 3. Bootstrap the first owner — exactly once

No migration seeds a user, so a newly migrated environment has no accounts at
all and nobody who could be authorized to create one. From a shell holding the
environment's `DATABASE_URL`:

```bash
read -rs EKON_OWNER_PASSWORD && export EKON_OWNER_PASSWORD
EKON_OWNER_USERNAME=<username> EKON_OWNER_DISPLAY_NAME='<full name>' \
  npm run identity:create-owner
unset EKON_OWNER_PASSWORD
```

It creates exactly one active `OWNER` and refuses if an active owner already
exists, so re-running it is safe and cannot produce a second account. Every
account after this one is created inside the application, in step 7. Reasoning
and the ways to keep the password out of shell history are in
[backend/src/modules/identity/README.md](../../backend/src/modules/identity/README.md).

### 4. Boot the application

The platform builds with `npm ci && npm run build` and starts the service. If
`EXPECTED_SCHEMA_VERSION` is missing or does not match the database, the process
exits during startup rather than serving a request — that is the check the whole
release procedure is built around.

### 5. Verify health, schema, and build identity

```bash
curl -s https://<host>/api/health
```

Check all four in the response:

- `status` is `ok` and `database` is `up`;
- `schemaVersion` equals the `EXPECTED_SCHEMA_VERSION` you set;
- `version` is the commit sha you deployed, not `dev`;
- the response carries an `x-request-id` header (`curl -si` to see it).

A `503` with `database: down` means the service is running and cannot reach the
database — a connection string, TLS, or network rule, not a bad build.

### 6. Sign in as the owner

Open `https://<host>/` and sign in with the credentials from step 3. A
successful sign-in sets the session cookie; confirm the browser shows it as
`Secure` and `HttpOnly`, which is what proves `NODE_ENV=production` really took
effect.

### 7. Create the employee accounts

Still signed in as the owner, use the new-account screen — visible only to
someone holding `identity.manage` — to create **one individual account per
person**. Each is created with a username, a display name, a password chosen
with that person, and the `EMPLOYEE` role.

Never a shared login. Every movement in the ledger records the user who posted
it, and that record is worth exactly as much as the certainty that the person at
the keyboard is the person signed in.

Creating an account does not sign anybody in and does not touch the owner's own
session.

### 8. Create the first product

Still signed in as the owner, on the products screen: **New product**. A name is
enough — a product sold one way is a single default variant, and that is what
"type a name and create" produces. A product sold in several sizes gets one
variant per size, each with its own attributes (`gwosè: 5 mamit`).

The catalog assigns the SKU. It is shown on the confirmation and is the
identifier to put on the shelf label; nobody chooses it, and it cannot be
changed afterwards.

A product cannot yet be edited, renamed, or deactivated, so this is worth doing
carefully with whoever knows the stock. A wrong one is replaced by creating the
right one and leaving the wrong one unused.

An employee cannot receive anything until at least one product exists, which is
why this comes before the next step and not after it.

### 9. Verify an employee can do the work

The deployment is not finished until somebody who is not the owner has done the
whole loop, on the hardware the shop will actually use. Signed in as an
employee:

1. read the catalog, and find the product created in step 8;
2. receive a small quantity into a location;
3. see that quantity in the current-stock view;
4. remove some of it;
5. see the balance fall by what was removed;
6. sign out.

If all six work, the business can open — the launch invariant at the top of this
document has been performed end to end. If step 2 or 4 fails, do not hand the
system over: the shop would take stock in on paper and nothing would be
recorded.

The employee should also see **no** product form and no new-account entry —
`catalog.write` and `identity.manage` are not theirs. If they do, the account
was created with the wrong role.

## Environment variables

Set in the platform's environment settings, never in a committed file.
`.env.example` documents every variable and its default.

**Required in every environment:**

| Variable       | Notes                              |
| -------------- | ---------------------------------- |
| `DATABASE_URL` | From the managed database provider |

**Required in production, on top of that:**

| Variable                  | Value              | Enforced by                                                              |
| ------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `NODE_ENV`                | `production`       | The application, which uses it to select the rules below                 |
| `EXPECTED_SCHEMA_VERSION` | The head migration | **The application** — production refuses to start without a valid pin    |
| `DATABASE_SSL`            | `true`             | The database provider, which refuses or downgrades the connection        |
| `APP_VERSION`             | The commit sha     | Nobody — it defaults to `dev`, so an unset value is a health check lying |

`EXPECTED_SCHEMA_VERSION` is the four-digit prefix of the last file in
`backend/migrations` for the revision being deployed — the value CI or the
release process reads from the build, not a number anybody types from memory. It
must be exactly four digits; blank, `8`, or `latest` is refused at startup with
the reason.

Development and test require none of the production values. Locally you migrate
by hand a minute before you start the server, so a pin there would be a value to
maintain rather than a guarantee — leaving it unset skips the check.

## Subsequent releases

1. Merge to `main`. CI must be green.
2. The platform builds: `npm ci && npm run build`.
3. **Release command runs first, before the new instance takes traffic:**
   `npm run migrate`. A failure aborts the deploy and the previous instance
   keeps serving.
4. The new instance boots, and refuses to start if its pin does not match the
   database.
5. Verify `/api/health` as in step 5 above: `schemaVersion` is the new head and
   `version` is the sha you just deployed.

The bootstrap in step 3 of the first deploy is **not** part of this loop.

## Rollback

Application code rolls back by redeploying the previous build. Its
`EXPECTED_SCHEMA_VERSION` is part of that build, so a rollback across a
migration boundary will refuse to start rather than run old code against a newer
schema — deliberate, and the moment to decide consciously what to do.

Migrations do not roll back; there is no `down`. Because migrations are
additive, the previous build usually runs against the newer schema once its pin
is updated. If a migration must be undone, write a new forward migration.

## Backups

**Nothing is configured on staging**, where the database holds no real
inventory. On a managed platform this is provider configuration:

1. the provider's automated daily backup with point-in-time recovery;
2. a weekly `pg_dump` to object storage, in a different account from the
   database.

For the self-hosted **OCI candidate** the repository does now carry a
backup job, a schedule, and a restore drill —
[`deploy/oci/scripts/`](../../deploy/oci/scripts/), documented in
[oci-zero-cost.md](oci-zero-cost.md). There the backup is not provider
configuration but part of the deployment, because there is no provider to do it:
a nightly `pg_dump` to OCI Object Storage, a weekly copy taken off Oracle
entirely, and a drill that restores into a disposable database.

**A restore must be practised into staging before real inventory is entered, and
at least once a year afterwards.** An untested backup is not a backup.

## When something is wrong

There is **no error-monitoring service and no log aggregation** — the
application reports to nobody, and nothing is shipped anywhere. What exists is
the health endpoint and the logs the process writes to stdout, read wherever the
hosting platform collects them.

The OCI candidate adds one thing on top of that, and it is external to
the application: an off-host HTTPS monitor polling `/api/health` and alerting a
real person on a non-200. It is a configuration step in
[oci-zero-cost.md](oci-zero-cost.md), not a dependency in this repository, and no
particular vendor is required.

1. **`/api/health`** — is the database up, and is `schemaVersion` what this
   build expects? This answers "is the instance broken" without shell access.
2. **The request id.** Every response carries `x-request-id`, and every error the
   API returns repeats it in the body, so a person reporting a failure can read
   the code off their screen. Search the log stream for it: the request's log
   lines carry it as `reqId`.
3. **The logs.** Unhandled errors are logged at `error` level, with the stack and
   the same `reqId`, on the line `unhandled error`; the client got a `500` with
   that id and nothing else. Expected failures — validation, a wrong password, a
   missing permission — are logged at `info` with their error code. Cookies,
   authorization headers, and password fields are removed before any line is
   written, so a log line never carries a credential.
4. **Failure to start.** A process that exits during startup has said why on
   stderr: an invalid configuration lists every problem it found, and a schema
   mismatch names both the version the build expects and the version the
   database is at. Both mean the instance never served a request.
