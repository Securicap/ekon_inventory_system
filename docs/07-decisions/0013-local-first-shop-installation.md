# 13. Ekon Local v1: the production target is an installation on the shop computer

**Status:** Accepted — 2026-09-15
**Supersedes:** [ADR 2](0002-cloud-hosted-not-shop-local.md)

## Context

[ADR 2](0002-cloud-hosted-not-shop-local.md) chose a cloud-hosted service with a
managed database, and made the shop laptop a browser client. It was decided on
two facts: the owner is abroad and must review inventory remotely, and the shop
machine is shared, unbacked-up hardware that nobody should trust as the only
copy of the records.

What the intervening year of work showed is that the first of those is a
_reporting_ requirement, not an operating one, and the second is a _backup_
requirement, not a hosting one. Meanwhile the cost the hosted design accepted
deliberately — "the shop cannot record inventory during an internet outage" —
turned out to be the cost that matters most. The shop is in Haiti. The
connection is not merely unreliable; there are days without one. A system the
employees cannot use on those days is not the shop's inventory system, whatever
else it is.

Hosted staging proved the software. It did not prove that the business can
depend on a link to it. Nothing about the product decided in
[ADR 11](0011-retail-merchandise-and-inventory-operations.md), or the OR1
milestone in [ADR 12](0012-operational-release-one.md), requires the database to
be somewhere else.

## Decision

**Ekon Local v1 — the application installed and running on the shop computer —
is the production target.** It is what OR1 is delivered as.

1. **Production runs on the shop computer.** The machine in the shop is the
   server and the client at once, not a terminal pointed at something else.
2. **The backend serves the frontend.** One process, one origin, as
   [ADR 3](0003-modular-monolith-single-deployable.md) already has it. No
   separate web server and no reverse proxy in the installed product.
3. **PostgreSQL 16 is local and bundled with the installer.** The same major
   version the schema, the tests, and CI use. The shop does not install a
   database, and the operator is never asked to.
4. **Both tiers bind to `127.0.0.1`.** The database and the application listen
   on the loopback interface only. Nothing Ekon installs is reachable from the
   shop's network or from the internet.
5. **No internet is required to operate.** Sign-in, receiving, removal,
   counting, correction, and history all work with the connection down, because
   nothing leaves the machine. Connectivity is not a dependency of any workflow.
6. **Backup and restore are production requirements, not options.** An
   installation is not fit to hold real inventory until a backup runs on a
   schedule, a copy of it leaves the machine, and a restore has been performed
   from that copy. This is the requirement ADR 2 satisfied by picking a managed
   database; the requirement did not go away when the database moved.
7. **Upgrades preserve data.** Installing a new version migrates the existing
   database in place. It never recreates it, and it never asks the shop to
   re-enter anything. This is the OR1 durability rule of ADR 12, applied to the
   installer.
8. **Hosted deployment remains possible later.** Nothing here is a rewrite. The
   same artifact that runs in a container runs on the shop computer; what
   changes is where PostgreSQL lives and who starts the process. Remote owner
   access — a synchronized read-only copy, or a hosted instance the shop
   replicates to — is a later milestone with its own decision, not a thing this
   one forecloses.

## Topology

```text
  Shop computer (Windows)
  ┌──────────────────────────────────────────────────────────────────┐
  │                                                                  │
  │   Browser  ──▶  http://127.0.0.1:<port>                          │
  │                        │                                         │
  │   ┌────────────────────▼─────────────────┐                       │
  │   │  Windows service: Ekon               │                       │
  │   │  Fastify + the built React frontend  │                       │
  │   │  one process, one origin             │                       │
  │   │  listens on 127.0.0.1 only           │                       │
  │   └────────────────────┬─────────────────┘                       │
  │                        │ 127.0.0.1:5432                          │
  │   ┌────────────────────▼─────────────────┐                       │
  │   │  Windows service: Ekon PostgreSQL 16 │                       │
  │   │  bundled by the installer            │                       │
  │   │  listens on 127.0.0.1 only           │                       │
  │   └────────────────────┬─────────────────┘                       │
  │                        │                                         │
  │   Program Files\Ekon\           application, binaries, static    │
  │     replaced wholesale on upgrade                                │
  │                                                                  │
  │   ProgramData\Ekon\             data, never touched by upgrade   │
  │     pgdata\                     the cluster                      │
  │     backups\                    dumps + checksums                │
  │     config\                     the installation's settings      │
  │     logs\                                                        │
  │                        │                                         │
  └────────────────────────┼─────────────────────────────────────────┘
                           │  operator-carried copy (removable drive
                           ▼   or, when there is a connection, off-site)
                    independent backup copy
```

Two Windows services, so the shop turns the computer on and Ekon is already
running — no terminal, no Docker, nobody remembering to start anything. The
split between `Program Files` and `ProgramData` is what makes point 7 true by
construction: an upgrade replaces the application directory and never opens the
data directory.

## Consequences

- The shop can work with no internet at all, which is the point.
- Latency stops being a design constraint. The bundle budget stays — a first
  load on old hardware still has to be cheap — but round trips are now local.
- **The owner's remote review is not delivered by v1.** That is a real loss
  against ADR 2 and it is accepted deliberately: the employees' ability to
  record stock every day outranks the owner's ability to read it from abroad
  every day. Until the sync milestone, remote review is a report the shop sends.
- **Backup becomes ours.** There is no provider taking daily snapshots. Point 6
  is therefore a release requirement with a checklist behind it, not advice.
- **Installation, upgrade, and service management become product surface.** An
  installer that gets this wrong can destroy the business's records, so it is
  built and tested to the same standard as the ledger.
- The database is single-writer and locally ordered exactly as before, so every
  ledger guarantee in [ADR 4](0004-append-only-ledger-with-before-after.md)
  holds unchanged.
- Offline queuing as ADR 2 and [ADR 6](0006-uuidv7-and-offline-readiness.md)
  imagined it is no longer on the critical path: there is nothing to queue
  against. UUIDv7 identities and retry-stable operation ids stay — they are what
  a future sync milestone would be built from.
- The hosted tooling that existed for the old target — the OCI runbook and its
  scripts, the Northflank/Supabase staging notes — is archived under
  `deploy/archive/` and `docs/06-operations/archive/` rather than deleted. The
  backup and restore-drill scripts there are the basis for the cross-platform
  backup commands this decision requires.
