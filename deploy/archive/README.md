# deploy/archive

**Archived. Nothing in this directory is deployed, run, or maintained.**

`oci/` is the tooling built for the cloud-hosted production candidate: a
`compose.yaml` and `Caddyfile` for one Oracle Cloud Always Free VM, a deploy
script that pins an exact commit, a verify script, a nightly backup to Object
Storage, and a restore drill. Its runbook is archived alongside it at
[docs/06-operations/archive/oci-zero-cost.md](../../docs/06-operations/archive/oci-zero-cost.md).

## Why it is archived

[ADR 13](../../docs/07-decisions/0013-local-first-shop-installation.md) made
**Ekon Local v1** — the application installed on the shop computer, with a local
PostgreSQL 16, both tiers bound to `127.0.0.1`, working with no internet — the
production target, superseding the cloud-hosted direction of
[ADR 2](../../docs/07-decisions/0002-cloud-hosted-not-shop-local.md). There is no
VM to provision, no public edge to terminate TLS at, and no provider to deploy
to. This tooling has no target.

It is kept rather than deleted because it is the written record of how the
hosted candidate was meant to be operated, and because the scheduled GitHub
workflow that hunted for A1 capacity, the OCI credentials it used, and the
staging service are all gone — this directory is what remains of that work.

## What is still live in here

`oci/scripts/backup.sh` and `oci/scripts/restore-drill.sh` were **the basis for
`ekon-ctl`**, which now carries their guarantees as product behaviour — see
[backend/src/cli/README.md](../../backend/src/cli/README.md). They were not
copied as-is — they are Bash, they shell into Docker, and they upload to Object
Storage, none of which applies on a shop computer. What carries over is their
ordering and their guarantees:

- dump to a temporary name and rename only on success, so a file with the final
  name is always a complete file;
- checksum every dump, and keep the checksum beside it;
- copy the dump off the machine before pruning any local copy;
- restore into a disposable database on its own storage, never into anything a
  shop is using, and report PASS or FAIL;
- no `restore-production` script — restoring live records is an operator
  procedure with deliberate steps, not something anybody can run by accident.

ADR 13 makes backup and restore production requirements rather than options, so
those rules are now product behaviour instead of runbook discipline. What
`ekon-ctl` changed deliberately:

- **there is a `restore` command.** The archived runbook had none on purpose,
  because an operator with a runbook was standing next to the VM. Nobody is
  standing next to a shop computer, so the command exists — and it never drops
  anything: the live database is renamed and kept until somebody names it to
  `--discard-previous`;
- **the drill restores into the same cluster**, not into a disposable container.
  A shop computer has no Docker, and "will this archive restore into this
  installation" is the question that actually matters;
- **nothing uploads.** A copy still has to leave the machine (ADR 13, point 6),
  but by an operator carrying a drive rather than by credentials for somewhere
  sitting on the shop computer permanently.
