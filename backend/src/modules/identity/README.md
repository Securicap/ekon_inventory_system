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

| Role          | Capabilities                                                              |
| ------------- | ------------------------------------------------------------------------- |
| `SUPER_ADMIN` | all                                                                       |
| `OWNER`       | all                                                                       |
| `MANAGER`     | all except `identity.manage`                                              |
| `EMPLOYEE`    | `catalog.read`, `inventory.read`, `inventory.receive`, `inventory.remove` |

An employee reads the catalog, reads stock, books in what arrives, and records
what leaves. That last one is `inventory.remove`, granted by migration 0008:
selling a bottle, discarding a broken one, and taking one for the shop's own use
are what somebody at the counter does all day, and an operating model that made
them fetch a manager to record a sale would be one nobody used — the stock would
leave the shelf anyway and the ledger would be the only thing that did not know.

**`inventory.remove` is not `inventory.adjust`, and an employee holds only the
first.** Removing stock says what happened; adjusting it says the record was
wrong. The second can make a shortfall disappear, so it is the one that has to
be given on purpose. Writing the catalog, adjusting or counting stock, reversing
a movement, reading the audit log, and exporting reports are all withheld for
the same kind of reason: each either changes what the numbers mean or can hide
the fact that they changed. Granting one of them later is a deliberate act.
Starting permissive and tightening afterwards is the wrong direction — by then
people are used to the access, and taking it back reads as an accusation.

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

| Route                   | Access        | Answers                                          |
| ----------------------- | ------------- | ------------------------------------------------ |
| `POST /api/auth/login`  | public        | `200` with the user, and sets the session cookie |
| `POST /api/auth/logout` | public        | `204`, always                                    |
| `GET /api/auth/me`      | authenticated | `200` with the current user, or `401`            |

`login` takes a username and a password and **nothing else** — no user id, no
role, no capability list, no session lifetime, no cookie option. The request
schema is strict, so a request carrying any of those is a `400` rather than a
field that is quietly ignored. Login carries no operation id and writes no
`operations` row: signing in twice must mint two sessions, not replay one.

The response to `login` and to `/me` is the same safe user — id, username,
display name, role, and current capabilities, sorted. There is no password hash
in it, no session id, and no expiry. `/me` does not authenticate for itself: the
enforcement hook below has already resolved the actor, and the handler returns
it — one session lookup per request, and one place that decides who is signed
in.

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

## Enforcement: who may call what

This module protects the whole application. Two mechanisms, installed by
`registerIdentity` on the root Fastify instance **before any other API route is
registered**, so that every module registered afterwards is covered.

### Every API route declares its access

A route says what it is, in its own `config`, next to the handler it guards:

```ts
{
  config: {
    auth: 'public';
  }
} // no session; nobody is looked up
{
  config: {
    auth: 'authenticated';
  }
} // a valid session, no capability
{
  config: {
    capability: 'catalog.write';
  }
} // a valid session that may do this
```

A capability implies authentication, so declaring both is a **startup failure**,
not a precedence rule — two statements of one fact can disagree, and a rule a
reader has to know is worse than an error they are told.

**A route under `/api/` that declares nothing does not start.** The check is an
`onRoute` hook, so it fires as routes are registered and the application refuses
to boot. That is the part of this design meant to survive people: every check in
the request hook is worthless against the endpoint somebody adds next year and
forgets to protect, and no review reliably catches an absence. Here the absence
is the failure. Fastify's generated `HEAD` routes carry their `GET`'s
declaration and pass on it; a hand-written `HEAD` must declare its own. Static
assets and the single-page fallback are not `/api/` and declare nothing.

### Every request is resolved before its handler

An `onRequest` hook — the earliest point at which the matched route is known —
reads the declaration and acts on it:

| Declaration     | What happens                                                             |
| --------------- | ------------------------------------------------------------------------ |
| `public`        | nothing. No session lookup, no cookie read, `request.actor` stays `null` |
| `authenticated` | resolve the session; `401` if it does not resolve                        |
| `capability`    | resolve the session; `401`; then `403` unless the actor holds it         |

`onRequest` rather than `preHandler` deliberately: an anonymous caller is
refused **before their body is parsed** and before any handler code exists to
reach. The only work an unauthenticated request buys is one indexed session
lookup — and on a public route, not even that.

Resolution goes through the same `authenticate()` the login PR built. No SQL is
duplicated, no other module reads `sessions`, and the guarantees are the ones
that call already made: missing, unknown, expired, and revoked tokens and
deactivated users are all refused, and role and capabilities are read **as they
are now**. So a grant removed from `role_capabilities`, a demotion, or a
deactivation lands on the very next request — no new sign-in, no session row
rewritten. One lookup per protected request; nothing is cached, and nothing
about the actor is ever put in the cookie.

### 401 and 403 are different answers

`401 UNAUTHENTICATED` — "Authentication required" — means nobody is signed in.
`403 FORBIDDEN` — "You do not have permission to perform this action" — means
somebody is, and they may not. The remedies differ: one is fixed by signing in
and the other by asking the owner. A `403` names neither the capability nor the
roles that hold it; the request id in the envelope is what turns a support call
into a log line. Neither is disguised as a `404`.

Authorization is **by capability, never by role**. No handler in this system
compares a role, and a role appears in an access decision only through
`role_capabilities`.

### The actor

`request.actor` is the person making the request, and the session cookie is its
only source. Nothing is read from a body, a query parameter, a header, a route
parameter, or an operation id — an actor the caller can write is not an actor.
A handler that needs the person calls `requireActor(request)`, which returns it
or fails as an internal error if the route's declaration and its handler
disagree about whether anybody is signed in. It never re-authenticates.

Receiving, adjustments, counts, and every other state-changing workflow will
take their `user_id` from there.

### Public, and why

`GET /api/health` — the platform deciding whether this instance takes traffic
cannot be asked to sign in first.

`POST /api/auth/login` — it is how a session is obtained.

`POST /api/auth/logout` — **intentionally public, and not a bypass.** Signing
out has to work when the cookie is missing, invented, expired, already revoked,
or belongs to somebody who has since been deactivated: in every one of those
cases the browser must still end up holding nothing. Requiring a valid session
to give one up would leave exactly the people with a broken session unable to
clear it. It revokes the presented session when there is one to revoke, answers
`204` regardless, and reveals nothing about what the cookie contained.

## In the browser

There is a login screen. The data model, the password utility, the owner
bootstrap, authentication, enforcement, **and a usable browser session** exist:
somebody can open the application, sign in, use the screens that are built, and
sign out.

The frontend's part is deliberately small, because the server holds everything
that matters:

- **`GET /api/auth/me` is the session source of truth.** The application calls
  it on every page load and renders nothing protected until it has an answer. A
  refresh restores the user the same way. Nothing about the session or the user
  is stored in `localStorage`, `sessionStorage`, IndexedDB, or a cookie written
  by frontend code — a copy in the browser would be a second answer to who is
  signed in, and it would survive a revocation this module can perform in one
  `UPDATE`.
- **The token never reaches JavaScript.** The cookie is `HttpOnly`;
  `credentials: 'same-origin'` is the whole of the client's part in carrying it.
  No `Authorization` header, no JWT, nothing to store. Login and logout send no
  operation id, matching the routes above.
- **A `401` from any protected request ends the session in the browser too**:
  every protected query is dropped and the login screen returns. A `403` does
  not — that person is signed in, and signing in again would change nothing.
- **Navigation is capability-driven**, and only for screens that exist. A link
  is not a permission: the enforcement hook above is the authority, and it
  checks every request whatever the browser drew.

The screens themselves are temporary and are not the platform's visual design.
See [frontend/README.md](../../../../frontend/README.md).

## Still missing

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

No other module may read `users`, `sessions`, or `role_capabilities` directly.
What the rest of the backend uses from here is `requireActor(request)` — and the
route `config` vocabulary above, which is how every module states its own
access.
