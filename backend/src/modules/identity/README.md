# `identity` module

**Owns:** `users`, `sessions`, `role_capabilities`

**Responsibility:** who is acting, and what they are permitted to do.

Not _which machine_ they are acting from. There is no device registry, no
browser identity, and no trusted-computer behaviour: an employee signs in from
whichever computer is free, and the permanent actor on a movement is the
authenticated user (ADR 9).

## The model

Each person has an **individual account** — never a shared login, because the
value of every audit record and every movement's `user_id` depends on the person
at the keyboard being the person signed in. They sign in with a **username and a
password**, from any browser or computer, in the shop or from another country
(ADR 10).

**Sessions are server-side rows**, not stateless tokens. The browser holds an
opaque random token; the database stores only its hash, so a leaked backup
yields nothing usable. Signing out, revoking a session, deactivating a user, or
changing someone's role therefore takes effect on the very next request rather
than whenever a token happens to expire.

A session row carries no IP address, user agent, device id, last-activity
timestamp, refresh token, payload, or **capability snapshot**. The first several
would make it a device registry by accident; technical request metadata belongs
in security logging, on its own retention schedule. A capability snapshot would
be worse than useless — a demoted user would keep their old permissions until
they signed out. **Capabilities are resolved from the user's current role on
every request**, so a role change or a deactivation lands immediately without
rewriting a single session row.

**Users are deactivated, never deleted.** Their name has to stay readable on
every movement they ever posted, and `sessions.user_id` references them with
`ON DELETE RESTRICT`. There is deliberately no `deleted_at`.

**Roles map to capabilities**, and business code authorizes through capabilities
only — `requireCapability(actor, 'inventory.adjust')`, never
`if (user.role === 'MANAGER')`. That is what lets the role model change later
without touching business logic. The mapping lives in `role_capabilities`,
seeded by migration 0007 to match `DEFAULT_ROLE_CAPABILITIES` in `@ekon/shared`;
a test fails if the two ever disagree.

| Role          | Capabilities                                          |
| ------------- | ----------------------------------------------------- |
| `SUPER_ADMIN` | all                                                   |
| `OWNER`       | all                                                   |
| `MANAGER`     | all except `identity.manage`                          |
| `EMPLOYEE`    | `catalog.read`, `inventory.read`, `inventory.receive` |

An employee reads the catalog, reads stock, and books in what arrives. Writing
the catalog, adjusting or counting stock, reversing a movement, reading the
audit log, and exporting reports are withheld: each either changes what the
numbers mean or can hide the fact that they changed. Granting one of them later
is a deliberate act. Starting permissive and tightening afterwards is the wrong
direction — by then people are used to the access, and taking it back reads as
an accusation.

Roles are a closed set and are not configurable at runtime, and there are no
per-user capability overrides. Changing what a role may do is a migration:
reviewable, and it leaves a record.

## Passwords

Argon2id, via `@node-rs/argon2`, at the library's own defaults. Plaintext is
never stored, never logged, and never put in an error message. The rules are two
length bounds — minimum 10 characters, maximum 128 — with **no composition
requirements**: a required digit and symbol add very little and reliably produce
`Password1!`, which is worse than the four ordinary words somebody would
otherwise have picked. Passwords are never trimmed; a leading space is a
character the person chose.

There is no PIN, no email address, no password hint, no security question, and
no recovery token. Password reset is an authenticated workflow for a later PR,
performed by someone holding `identity.manage`.

## Creating the first owner

A new installation has no users, so there is nobody who could be authorized to
create one. One command answers that, once:

```bash
EKON_OWNER_USERNAME=marie.j \
EKON_OWNER_DISPLAY_NAME='Marie Joseph' \
EKON_OWNER_PASSWORD='<chosen by the owner>' \
npm run identity:create-owner
```

It creates exactly one active `OWNER`, and refuses if any required value is
missing or invalid, if the username is taken, or if an active owner already
exists. There is no force flag and it cannot create a second account: everyone
after the first owner is created through the signed-in identity workflow, by
someone holding `identity.manage`. No user and no password is seeded by any
migration, so no installation ships with a default credential.

**Handling the password.** The value is visible in the environment of the
process that runs the command and, depending on the shell, in shell history.
Keep it out of both:

- read it in without echoing it, and let it leave with the shell —
  `read -rs EKON_OWNER_PASSWORD && export EKON_OWNER_PASSWORD`;
- or rely on the shell's history-ignores-leading-space setting (`HISTCONTROL`,
  `HIST_IGNORE_SPACE`);
- do **not** put it in `.env`. That file persists on disk, and this value is
  needed exactly once.

Command-line arguments are deliberately not supported: `ps` shows every
process's arguments to every user on the machine.

## Where the invariants live

In the database, as constraints, not only in the code that usually writes these
rows:

| Guarantee                                     | Mechanism                                      |
| --------------------------------------------- | ---------------------------------------------- |
| A username is stored trimmed and lower-cased  | `CHECK (username ~ '^[a-z0-9._-]{3,40}$')`     |
| One person, one username                      | `UNIQUE (username)`                            |
| The password column is nonblank and bounded   | `CHECK` trimmed, nonblank, `length <= 512`     |
| The role is one of the four                   | `CHECK (role IN (...))`                        |
| A raw session token is never stored           | only `token_hash`, `UNIQUE`                    |
| A session cannot expire before it began       | `CHECK (expires_at > created_at)`              |
| A user with sessions cannot be deleted        | `ON DELETE RESTRICT`                           |
| Only known roles and capabilities are granted | `CHECK` on both columns of `role_capabilities` |

Two rules deliberately live in application code instead.

**Which hashing algorithm is used.** `password_hash` is constrained structurally
— nonblank, trimmed, bounded — and the database does not try to recognize an
Argon2 string. A CHECK on the encoding would make the schema an authority on
which algorithm is correct, a claim it cannot keep: it would need migrating in
lockstep with any algorithm change, and would forbid the interim state where old
and new hashes coexist while accounts rehash on sign-in. `hashPassword` is the
only function in the system that produces a stored credential and it hashes with
Argon2id; its unit tests are where that is asserted.

**Session expiry.** Whether a session has expired is a question about the moment
a request arrives, answered by application code against the injected clock. A
constraint against the database clock would make an expired row unwritable and
an existing row retroactively invalid.

`citext` is deliberately unused, despite being installed by migration 0001 for
this purpose. Case-insensitive comparison would let `Marie` and `marie` be one
login while two different-looking strings sat in the column, and there would
then be a display case of the username to keep in step with the identity case.
One canonical stored form is simpler, and a duplicate is an ordinary `UNIQUE`
violation.

## Not in this PR

The data model, the password utility, and the owner bootstrap exist. **There is
no authentication yet**, and no route reaches this module:

- no login, logout, or `/api/auth/me` route; no cookies; no Fastify
  authentication hook; no request principal;
- **no capability enforcement** — the catalog and inventory routes declare the
  capability they will require and remain unauthenticated until it is wired up;
- no user-management API or UI, no login screen, no password-reset workflow;
- no session cleanup job, rate limiting, account lockout, or password history;
- no foreign key from `inventory_movements.user_id` to `users`. Existing
  movements carry arbitrary test actor UUIDs, and the strategy for connecting
  permanent history to real users is its own decision.

`requireCapability(actor, capability)` will be exposed here when there is an
actor to pass it. No other module may read these tables directly.
