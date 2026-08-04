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
length bounds — minimum 10 characters, maximum 128, defined once in
`@ekon/shared` so the login form and the login route cannot disagree about them,
and nothing about hashing crosses that line — with **no composition
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

## Signing in

Three routes, and they are the module's whole HTTP surface:

| Route                   | Answers                                          |
| ----------------------- | ------------------------------------------------ |
| `POST /api/auth/login`  | `200` with the user, and sets the session cookie |
| `POST /api/auth/logout` | `204`, always                                    |
| `GET /api/auth/me`      | `200` with the current user, or `401`            |

`login` takes a username and a password and **nothing else** — no user id, no
role, no capability list, no session lifetime, no cookie option. The request
schema is strict, so a request carrying any of those is a `400` rather than a
field that is quietly ignored. Login carries no operation id and writes no
`operations` row: signing in twice must mint two sessions, not replay one.

The response to `login` and to `/me` is the same safe user — id, username,
display name, role, and current capabilities, sorted. There is no password hash
in it, no session id, and no expiry.

**A failed sign-in has one answer.** An unknown username, a wrong password, and
a deactivated account all return `401 UNAUTHENTICATED` with
`Invalid username or password`. Anything that distinguished them would turn the
login form into a way to ask which usernames exist and which of those still
work. They also cost roughly the same: an unknown username is still verified
against a fixed dummy Argon2id hash owned by this module, and a deactivated
account is refused only _after_ its real hash has been checked. That is not
constant time and does not claim to be — it is the difference between "not
trivially distinguishable" and "measurable from the other side of the internet".

### The session

The browser is given an opaque token: 32 bytes from the platform CSPRNG,
base64url, in a cookie named **`ekon_session`**. The database stores only its
SHA-256 digest, so a leaked backup yields nothing that can be presented to the
server. The token is not a UUID, not a JWT, and not an encrypted payload; it is
never returned in JSON, never logged, never in an error, and never readable by
frontend JavaScript.

| Cookie attribute | Value      | Why                                                     |
| ---------------- | ---------- | ------------------------------------------------------- |
| `HttpOnly`       | always     | an injected script cannot walk away with a session      |
| `SameSite`       | `Lax`      | another site cannot post as whoever is signed in        |
| `Path`           | `/`        | one session for the API and the pages alike             |
| `Max-Age`        | `43200`    | the same twelve hours as the row, from one constant     |
| `Secure`         | production | a browser silently drops it on plain `http://localhost` |
| `Domain`         | never set  | host-only; one origin serves everything                 |

The cookie is not signed, and there is no signing secret. Possession of the
token is the credential, and its validity is decided by a hash lookup against a
row — a stronger check than a signature, with nothing to keep safe.

**Twelve hours, absolute.** No idle timeout, no sliding expiration, no remember
me, no refresh token. A sliding window is the option that quietly never ends,
and an idle timeout signs somebody out mid-count. Twelve hours covers a working
day and is over by the next one: you sign in once a day.

**Several sessions at once are normal.** The owner can be signed in from another
country while the shop laptop is signed in too. A new sign-in does not revoke an
old one, and signing out ends **only the session that was presented** — never
every session the person has.

**A session is refused when** its token matches no row, it has been revoked, it
has expired, or the user has been deactivated. All four are one condition in one
query, so there is no order of checks to get wrong and no way to ask which of
them failed. Expiry is judged against the injected clock, never the database's
`now()`.

**Nothing is written when a session is resolved.** No sliding expiry, no
last-activity timestamp. `/me` is a read, which is what keeps an authenticated
request to a single query.

**Role and capabilities are resolved on every request**, from `users` and
`role_capabilities` as they are now. A promotion, a demotion, a deactivation, or
a change to what a role may do lands on the next request without rewriting or
replacing a single session row.

Signing out revokes the row — it sets `revoked_at` — and never deletes it. It
answers `204` whether the cookie held a real token, an expired one, an
already-revoked one, or nothing at all, and clears the cookie either way. A
logout that answered differently would be a way to ask whether a token is real.

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

The data model, the password utility, the owner bootstrap, and **authentication**
exist. A person can sign in, be recognised, and sign out. What that does _not_
yet do is protect anything:

- **no capability enforcement.** There is no authentication hook, no request
  principal, and no `403`. The catalog and inventory routes declare the
  capability they will require in their route `config` and **remain
  unauthenticated** — anyone who can reach the server can still call them. That
  hook, the principal it decorates, the public-route metadata it reads, and the
  protection of every existing business route are one coherent change and arrive
  together in the next PR;
- **no login screen.** The frontend has no login form, no session state, and no
  authenticated shell; the API client already sends `credentials: 'same-origin'`,
  so the cookie will simply work when there is a screen to use it. That is the
  PR after next;
- no user-management API or UI, no password change, no password-reset workflow,
  no session listing, and no "sign out everywhere";
- **no rate limiting**, account lockout, or CAPTCHA on the login route. The
  defence against guessing is the credential itself — ten characters minimum,
  Argon2id, no PIN (ADR 10) — and rate limiting is infrastructure that should be
  chosen deliberately rather than bolted on here;
- no session cleanup job. Expired rows are refused on sight but accumulate; at
  this volume that is a housekeeping task, not a defect;
- no audit event for signing in or out, no IP address, no user agent, no device
  identity;
- no foreign key from `inventory_movements.user_id` to `users`. Existing
  movements carry arbitrary test actor UUIDs, and the strategy for connecting
  permanent history to real users is its own decision.

`requireCapability(actor, capability)` will be exposed here when there is a
protected route to call it from. No other module may read these tables directly.
