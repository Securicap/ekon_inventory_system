# Deployment

## Status: not yet

This describes how the system will be deployed, and the procedure is ready to
follow. It has not been done, deliberately.

The application is usable in a browser — sign in, read the catalog and the
inventory locations, sign out — but the business cannot yet do the thing it
needs the system for: **receiving stock**. Deploying before the first inventory
workflow works end to end would put a production database and a backup schedule
behind an application nobody can enter inventory with, and would mean the first
real migration against real data happens before anyone has watched one work.

**Full production deployment is reviewed once receiving works end to end.**
Nothing here changes when it is; there is simply no environment to run it
against yet.

## Shape

One managed web service and one managed PostgreSQL database, in a US East
region for latency to Haiti. Nothing runs in the shop.

The web service serves the API _and_ the built frontend from one origin, so
there is one deploy, one certificate, no CORS, and no cookie-domain problem for
the session cookie. There is no separate frontend host.

## Environments

| Environment  | Purpose                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `staging`    | Proves migrations against a copy of production's schema before real inventory is touched |
| `production` | The business's records                                                                   |

## Release procedure

1. Merge to `main`. CI must be green.
2. The platform builds: `npm ci && npm run build`.
3. **Release command runs first, before the new instance takes traffic:**
   `npm run migrate`. Each migration runs in its own transaction. A failure
   aborts the deploy and the previous instance keeps serving.
4. The new instance boots. If `EXPECTED_SCHEMA_VERSION` is set and does not
   match the database, it refuses to start rather than serving requests against
   a schema it does not understand.
5. Verify: `curl https://<host>/api/health` should return `status: ok` with the
   expected `schemaVersion` and `version`.

## First deploy only: create the owner account

No migration seeds a user, so a newly provisioned environment has no accounts at
all. Once it is migrated, run the bootstrap command **once**, from a shell with
the environment's `DATABASE_URL`:

```bash
read -rs EKON_OWNER_PASSWORD && export EKON_OWNER_PASSWORD
EKON_OWNER_USERNAME=<username> EKON_OWNER_DISPLAY_NAME='<full name>' \
  npm run identity:create-owner
unset EKON_OWNER_PASSWORD
```

It refuses if an active owner already exists, so re-running it is safe. Every
account after the first is created by the owner from inside the application.
Details and the reasoning are in
[backend/src/modules/identity/README.md](../../backend/src/modules/identity/README.md).

## Environment variables

Set in the platform's environment settings, never in a committed file. See
`.env.example` for the full list. Production must set:

- `DATABASE_URL` (from the managed database)
- `DATABASE_SSL=true`
- `NODE_ENV=production`
- `EXPECTED_SCHEMA_VERSION` (the head migration for this build)
- `APP_VERSION` (the commit sha)

## Backups

Two independent copies, because this is the business's only record of its
inventory:

1. The provider's automated daily backup with point-in-time recovery.
2. A weekly `pg_dump` to S3-compatible object storage, in a different account.

**A restore must be practised into staging before real inventory is entered, and
at least once a year afterwards.** An untested backup is not a backup.

## Rollback

Application code rolls back by redeploying the previous build.

Migrations do not roll back — there is no `down`. Because migrations are
additive, the previous build almost always runs against the newer schema. If a
migration must be undone, write a new forward migration.

## What to check when something is wrong

1. `/api/health` — is the database up, and at the expected schema version?
2. Application logs — every response carries an `x-request-id`; a user reporting
   a failure can read that code off the screen.
3. Error monitoring — unhandled errors are reported with the same request id.
