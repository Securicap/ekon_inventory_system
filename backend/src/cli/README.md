# `ekon-ctl` — operating an installation

Everything an operator does to an Ekon installation, as one command.

The shop computer has no platform console, no `docker exec`, no ssh, and nobody
on site who would use one (ADR 13). What it has is a machine that needs
migrating on upgrade, backing up nightly, restoring after a disaster, and
explaining when something goes wrong.

```
ekon-ctl migrate                      apply pending migrations
ekon-ctl migrate-status               what is applied and what is not
ekon-ctl create-owner                 the first owner, from the environment
ekon-ctl backup [--tag <name>]        dump, verify, checksum, prune, record
ekon-ctl restore-drill <file>         prove a backup restores (throwaway db)
ekon-ctl restore <file> --yes         put a backup back (keeps the old one)
ekon-ctl diagnostics                  a bundle support can read
```

Every subcommand loads and validates the **whole** configuration first, from the
environment or from the file `EKON_CONFIG_FILE` names. A backup that ran against
a half-configured environment would be the worst possible thing to discover
afterwards.

In development the same code runs through npm, and the scripts that existed
before this still work:

```
npm run migrate                 # = ekon-ctl migrate
npm run migrate:status          # = ekon-ctl migrate-status
npm run identity:create-owner   # = ekon-ctl create-owner
npm run ekon-ctl -- backup --tag before-upgrade
```

## `backup`

```
ekon-ctl backup
ekon-ctl backup --tag before-upgrade
```

Dumps `DATABASE_URL` into `EKON_BACKUP_DIR` with `pg_dump --format=custom
--no-owner --no-privileges`, and does it in an order that is the whole design:

| step                      | what it buys                                                      |
| ------------------------- | ----------------------------------------------------------------- |
| dump to `.ekon-….partial` | a truncated dump can never be mistaken for a finished one         |
| verify, then rename       | a file with the final name is a complete, checked file            |
| write the `.sha256`       | "the backup exists" becomes "the backup is intact", for anybody   |
| prune last                | the last good copy is never deleted because something else failed |

The dump is checked for the `PGDMP` magic bytes before it is renamed: catching a
shell error message that landed in the file here is cheaper than discovering it
during a restore six months from now. The checksum is written in `sha256sum`
format, so an operator on any machine with no Ekon tooling can run
`sha256sum --check ekon-….dump.sha256`.

`--tag` marks a backup **permanent**: nothing ever prunes a tagged file. Tags are
short labels (letters, digits, `-`, `_`), because they end up in a filename.

**Retention.** One backup is kept from each of the most recent
`BACKUP_KEEP_DAILY` (14) days that has one, and from each of the most recent
`BACKUP_KEEP_WEEKLY` (8) ISO weeks. Buckets are counted in _days that have a
backup_, not calendar days — a shop that was shut for a fortnight comes back to
fourteen backups, not to an empty directory, which is the case a naive "older
than N days" rule gets catastrophically wrong.

**Every run is recorded** in `<EKON_STATE_DIR>/last-backup.json`, success or
failure, and `GET /api/system/status` reports it. A failure writes `ok: false`
with the error and leaves no `.partial` behind. A backup that failed silently
would read on the status screen exactly like a shop that never set one up.

Nothing here moves the backup off the machine. ADR 13 requires a copy to leave
the computer, and in Ekon Local that is an operator carrying a drive — not a
network call this command makes, which would mean credentials for somewhere
sitting on the shop computer permanently.

## `restore-drill`

```
ekon-ctl restore-drill /var/lib/ekon/backups/ekon-20260915T031500Z.dump
```

An untested backup is not a backup. This is the test, and ADR 13 makes it a
release requirement: an installation is not fit to hold real inventory until a
restore has been performed from a copy that left the machine.

It verifies the checksum and the magic bytes, creates `ekon_restore_drill` on the
same cluster (dropping any leftover first), restores into it with
`pg_restore --exit-on-error`, and then checks what arrived: the
`schema_migrations` head, the twelve core tables, an active owner, the movement
and balance counts, and the ledger's own invariant — that no balance row exists
without movements behind it (INV-6). Then it drops the database, in a `finally`,
whether or not anything failed. It exits non-zero on any failed check.

It refuses a file from outside `EKON_BACKUP_DIR` unless `--allow-external`, which
is the deliberate way to test a copy somebody carried in on a drive.

The drill restores into the **same cluster** the backup came from. The archived
OCI script started a disposable PostgreSQL container, which proved more and cost
a Docker daemon; a shop computer has no Docker, and "will this archive restore
into this installation" is the question that actually matters.

## `restore`

```
ekon-ctl restore /var/lib/ekon/backups/ekon-20260915T031500Z.dump --yes
```

The most dangerous command in the product, and shaped accordingly.

**Nothing is destroyed.** The live database is _renamed_ — `ekon` becomes
`ekon_pre_restore_20260915T031500Z` — and stays on the cluster, complete, until
somebody deliberately names it to `--discard-previous`. An operator who restores
the wrong archive at four in the morning has made a reversible mistake, which is
the only kind worth designing for.

**It refuses to run by accident.** `--yes` is required; without it the command
prints exactly what it would do and stops.

Other connections are terminated before the rename, because the Ekon service
holds a pool and a rename fails while anything is attached. Stop the service
first anyway — this is what makes the command work when somebody did not.

After `pg_restore`, migrations run: a backup may predate the installed build, and
an upgrade migrates in place rather than asking a shop to re-enter anything
(ADR 13, point 7).

`--discard-previous <database>` drops a database displaced by an **earlier**
restore. It refuses a name that is not `ekon_pre_restore_<stamp>`, and it refuses
the one this run just created — that copy is the way back if this restore was the
wrong one.

## `diagnostics`

```
ekon-ctl diagnostics
```

Writes `<EKON_STATE_DIR>/ekon-diagnostics-<stamp>.zip` containing the build and
profile, the schema state, row counts per table, the last backup, the version
file, and whatever log files are in `<EKON_STATE_DIR>/logs`.

**No business rows of any kind.** Not a product, not a movement, not a user, not
a username. The row _counts_ are there because "movements: 0" and
"movements: 41,208" are different problems, and a count says which without saying
what. The database password is redacted wherever the connection string appears.

A diagnostics bundle is something a person emails. It has to be safe to email
without anybody reading it first.

## `create-owner`

Reads `EKON_OWNER_USERNAME`, `EKON_OWNER_DISPLAY_NAME`, and
`EKON_OWNER_PASSWORD` from the **environment** — never from arguments, which
`ps` shows to every user on the machine. See
`backend/src/modules/identity/README.md` for how to pass them without leaving the
password in a shell history.

On an installed product this is usually not needed: a browser opened against a
fresh installation offers the first-run setup screen. The command remains as the
way to recover an installation that has lost its owner, and it is the one path
that still works when nobody can reach a browser.

## Which PostgreSQL binaries

`EKON_PG_BIN` names the directory of the PostgreSQL the installation bundles.
Version matters more than convenience: `pg_dump` refuses to dump a server newer
than itself, and an archive written by a newer `pg_dump` may not restore into an
older server — and a shop computer easily ends up with some other PostgreSQL's
tools first on `PATH`. Unset means "whatever is on `PATH`", which is what a
developer's machine wants.

Credentials are never passed as arguments. The connection string is decomposed
into `PGHOST`/`PGUSER`/`PGPASSWORD`/… in the child's environment, because `ps`
shows every process's arguments to every user on the machine and a dump runs for
a while.

**`psql` is not spawned.** The commands here that need SQL — creating and
dropping the drill database, the drill's checks, the row counts — use the `pg`
client the application already depends on, so nothing parses a tool's text
output to decide whether a restore worked. `EKON_PG_BIN` still resolves `psql`
for an operator who wants it.

## Which connection

`ekon-ctl` runs as the **database owner**, not as the restricted application
role. Migrations are DDL, and a restore creates and renames databases; migration
0014 deliberately grants `ekon_app` none of that. So `DATABASE_URL` for an
operator command is not the connection string the service runs with.

## Tests

- Unit: naming and stamps, retention selection, checksum and magic bytes,
  argument parsing, connection decomposition, the zip writer (round-tripped
  through the system `unzip`).
- Integration: `backend/tests/integration/backupRestoreDrill.test.ts` takes a
  real dump of a real database with the real `pg_dump`, restores it with the real
  `pg_restore`, and checks what came back. It is skipped where the PostgreSQL
  client tools are absent — a developer running the database in Docker — and
  **fails rather than skipping in CI**, where the workflow installs
  `postgresql-client-16` precisely so that it runs.
