# deploy/oci

Everything needed to run Ekon on one OCI Always Free VM: Caddy, the application,
PostgreSQL, a nightly backup that leaves the machine, and a restore drill that
proves the backup works.

**The runbook is [docs/06-operations/oci-zero-cost.md](../../docs/06-operations/oci-zero-cost.md).**
It is the canonical document — provisioning, firewall, block volume, Object
Storage, recovery, and the acceptance checklist that decides whether this is
allowed to hold real inventory. This file is only a map of the directory.

```text
deploy/oci/
  compose.yaml              caddy + app + postgres, two networks
  Caddyfile                 the public edge; automatic HTTPS
  production.env.example    placeholders; copy to production.env (gitignored, chmod 600)
  scripts/
    deploy.sh               deploy one exact commit, and verify the running app is it
    verify.sh               health check that fails on the wrong build SHA
    backup.sh               pg_dump -> checksum -> Object Storage -> prune
    restore-drill.sh        restore into a disposable database and report PASS/FAIL
```

## The rule

Staging once reported `"version": "staging"` while running a commit nobody could
name. `APP_VERSION` here is derived from the deployed commit by `deploy.sh`, and
`verify.sh` fails the deployment if `/api/health` reports anything else. No
operator types a version.

## Usage

```bash
cp production.env.example production.env && chmod 600 production.env
$EDITOR production.env

./scripts/deploy.sh <sha>                     # deploy and verify
./scripts/verify.sh                           # re-verify at any time
./scripts/backup.sh                           # nightly, via systemd timer
./scripts/restore-drill.sh <path-to.dump>     # monthly
```

## Boundaries

- **Not staging.** Northflank + Supabase remains staging and keeps
  `DATABASE_SSL=true`. Here it is `false` on purpose: the connection never
  leaves the VM's internal Docker network.
- **Not production yet.** The acceptance checklist in the runbook decides that.
- **No business logic.** These scripts run the application's own commands
  (`npm run migrate`, `npm run identity:create-owner`) and contain no SQL and no
  domain rules.
- **No `restore-production.sh`.** Restoring live records is an operator
  procedure with deliberate steps, in the runbook — not a script somebody can
  run by accident.
