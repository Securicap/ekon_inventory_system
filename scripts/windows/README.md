# The Windows application layout

What an Ekon installation is, as a directory tree, before anything exists to
install it.

```bash
node scripts/windows/build-layout.mjs
```

That builds every workspace, downloads and verifies the two pinned artifacts,
and assembles `dist-windows/`. On CI it runs on `windows-latest` and the tree is
uploaded as a build artifact — which is the whole point of this phase: the
layout can be built, downloaded, and argued about before anything is wired to
start automatically on a shop's till.

**Nothing in `dist-windows/` runs yet.** There is no service, no launcher, no
installer, and no cluster initialisation. Those are later phases.

## What comes out

```
dist-windows/
  app/                       ADR 13's `Program Files\Ekon\`
    node.exe                 the pinned runtime — the interpreter, nothing else
    package.json             pruned: production dependencies, "type": "module"
    version.json             appVersion · schemaVersion · pgMajor
    dist/                    the compiled backend; dist/main.js is the entry point
      cli/ekonctl.js         the operator CLI
    public/                  the built frontend, served from the same origin
    migrations/              applied by `ekon-ctl migrate` on install and upgrade
    node_modules/            production dependencies, win32-x64
      @ekon/shared/          copied, not linked
  pgsql/                     the bundled PostgreSQL 16
    bin/ lib/ share/
```

`app/` mirrors `backend/` at its root, and that is load-bearing rather than
tidy: `dist/main.js` resolves its migrations as `../../../migrations`, and
`STATIC_DIR=./public` resolves from the working directory. A service started
with its working directory set to `app/` finds both without a single path being
configured.

## The decisions

**Both bundled artifacts are pinned by checksum** in `versions.json`, and
verified before a byte is unpacked — including cached ones, every run. A build
that cannot prove what it downloaded stops; it does not warn and continue. If a
checksum ever fails, the remedy is to find out what changed upstream and rotate
the pin deliberately. Editing `versions.json` to make the build pass is how a
supply-chain compromise gets shipped to a shop.

**The runtime is the interpreter and nothing else.** No npm, no corepack, no
headers. The application ships with `node_modules` already installed, so nothing
on a shop computer would ever install a package — and a package manager on a
machine with no internet, next to the business's records, buys nothing.

**PostgreSQL ships as `bin`, `lib`, and `share`.** The EDB archive also carries
documentation, headers, debug symbols, and pgAdmin; they are most of its size,
none of them is reachable from anything Ekon does, and a till should not be
carrying a database GUI nobody asked for.

**Dependencies are pinned to what this checkout installed**, not to the semver
ranges in `backend/package.json`. What ships is the tree the tests ran against
rather than whatever the ranges resolved to that afternoon.

**Native binaries are selected for Windows explicitly** (`--os=win32 --cpu=x64`),
so a layout built on Linux is the same layout. That is not trusted: the build
asserts `@node-rs/argon2-win32-x64-msvc` is present afterwards, because npm
ignores flags it does not recognise, and a Linux binary in that directory looks
perfectly healthy and dies on the first password hash — which on a shop computer
is the first sign-in of the first morning.

**`@ekon/shared` is copied into `node_modules`, not linked.** A junction
survives on the machine that made it and breaks the moment an installer copies
the tree into `Program Files`, which is exactly what happens to this directory.

**Zips are unpacked by `zip.mjs`,** a small reader in this directory, rather
than by `unzip`/`tar`/`Expand-Archive`. One code path instead of two, no
dependency, and identical behaviour wherever the build runs.

## `version.json`

```json
{ "appVersion": "v1.4.0", "schemaVersion": "0015", "pgMajor": 16 }
```

Every field is derived from the artifact being assembled: `schemaVersion` from
the migrations actually copied into the layout, `pgMajor` from the pinned
PostgreSQL version, `appVersion` from `git describe` (falling back to the
workspace version). The application reads it at boot through `EKON_VERSION_FILE`
and refuses to start if the environment disagrees with it — see
`backend/src/config/versionFile.ts`.

The derivation logic lives in `layout.mjs` and is unit-tested in
`backend/tests/unit/windowsLayout.test.ts`, because it is the part that can be
wrong without anything failing: a `version.json` pinning `0014` on a build
carrying fifteen migrations is an installation that refuses to start, in a shop,
months later.

## Flags and caching

| Flag             | What it does                                                   |
| ---------------- | -------------------------------------------------------------- |
| `--skip-build`   | Assemble from whatever is already built. For iterating.        |
| `--skip-install` | Skip `npm install` into `app/`. Produces an incomplete layout. |

Downloads are cached in `.cache/windows-artifacts/` (gitignored). CI caches the
same directory, keyed by the hash of `versions.json`.
