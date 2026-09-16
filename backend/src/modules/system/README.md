# `system` module

**Owns:** no table.

**Responsibility:** what the installation says about itself — which build, which
schema, which profile, whether a backup finished, and how much room is left to
write the next one.

## Why it exists

Ekon Local is installed on a computer in a shop with nobody on site who
administers anything (ADR 13). There is no provider taking daily snapshots, no
console to open, no monitoring agent, and no email. Every question an operator
would normally ask infrastructure has to be answerable from inside the
application, or it does not get asked at all — and the one that matters is
whether the business's records are being copied.

This module is the answer to that, and nothing else.

## Currently provides

- `GET /api/system/status`, requiring **`system.manage`** (migration 0015,
  granted to `OWNER` and `SUPER_ADMIN`):

```jsonc
{
  "appVersion": "1.4.0",
  "schemaVersion": "0015",
  "profile": "local",
  "lastBackup": {
    "finishedAt": "2026-09-15T03:15:00.000Z",
    "ok": true,
    "file": "ekon-20260915T031500Z.dump",
  },
  "backupDirFreeBytes": 41231122432,
}
```

## Decisions

**It owns no table, and should not grow one.** Every fact here is read from
somewhere that already holds it: the configuration, `schema_migrations`, the
`last-backup.json` that `ekon-ctl backup` writes, and the filesystem. A table of
"system events" would be a second record of things that already have one, and
the first thing to drift.

**It writes nothing.** There is no endpoint that takes a backup, runs a restore,
applies a migration, or restarts a service — those are `ekon-ctl`, run by
somebody with the machine in front of them. Each can destroy the business's
records, and none should be one mis-click away on a screen an owner opens while
worried.

**`system.manage` rather than `audit.read` or `inventory.read`.** Audit is about
what people did; this is about what the machine is doing. Reusing an existing
capability would have meant that granting somebody the ability to read stock
history also told them when the records were last copied — which is the same
fact as how much would be lost.

**Not granted to `MANAGER`.** A manager runs the shop floor. Whether the
business could survive losing the computer is the owner's question, and the
person who would have to act on a failed backup is the person who owns the
records. A shop that wants a manager watching it grants this later; starting
narrow and widening is the direction that works.

**A failed backup is a result, not an absence.** `lastBackup.ok: false` is the
most important thing this endpoint can say. Reporting a failed run as "no backup
yet" would hide it behind the same answer a fresh installation gives, and both
get shrugged at.

**Five facts, no metrics.** No CPU, no memory, no connection count, no uptime,
and no count of anything the business entered. None of those is actionable by
the owner of a shop, and each would invite a screen that watches numbers instead
of answering the one question that matters.

**Nothing here can fail the request.** The schema read, the state file, and the
disk each degrade to `null`. Somebody opened this screen _because_ something is
wrong; an endpoint that answered 500 when one of four readings was unavailable
would be silent at exactly the moment its other three answers were most worth
having.

**No path on the wire.** `lastBackup.file` is a filename, never a full path. A
path would put the installation's directory layout on a screen and tell a caller
where the records are kept, which answers no question the screen asks.

## Not here, on purpose

- **The System screen.** This is the endpoint; the screen is Phase 3.
- **Triggering a backup.** `ekon-ctl backup`, on a schedule the installer sets.
- **Anything about the shop's data.** Row counts live in the diagnostics bundle,
  which support reads and an owner sends deliberately — not on an HTTP endpoint.

## See also

- `backend/src/cli/README.md` — `ekon-ctl`, which writes what this reads.
- `backend/src/platform/installation/backupState.ts` — the shape both sides
  agree on.
- `docs/07-decisions/0013-local-first-shop-installation.md` — point 6: backup and
  restore are production requirements, not options.
