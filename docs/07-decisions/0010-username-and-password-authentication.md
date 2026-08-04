# 10. Authentication is username and password, from any browser

**Status:** Accepted — 2026-08-03. Supersedes the PIN and session-metadata parts
of ADR 7. Server-side sessions, from the same ADR, stand unchanged.

## Context

ADR 7 chose username + numeric PIN, and gave session rows an IP address and a
user agent. Both followed from one picture of the business: employees share a
shop laptop, take turns at it during a shift, and need to switch users quickly
at a counter. A PIN is fast to type on a machine somebody else is waiting for,
and a session's IP and user agent would tell the owner which of those turns was
which.

ADR 9 removed the other half of that picture. The permanent actor is the
authenticated user; whether several people share one computer or one person
works from several has no business significance and is not modelled. What is
left of ADR 7's reasoning is a short credential chosen for a shared-machine
workflow the system no longer has a concept of.

The reason that matters more: this system is on the public internet, reachable
by anyone who finds the address. A four- or six-digit PIN is a keyspace of ten
thousand or a million, exhaustible in seconds by an attacker with a script, and
Argon2id does not change that — hashing protects a stolen database, not a login
form. Defending a PIN against the open internet means rate limiting, lockout,
and the operational burden of a shop that can lock itself out, all bolted onto a
credential that was chosen for the convenience of a counter that is no longer
the design point. The owner also works from another country, where nothing about
the shop laptop applies at all.

## Decision

**Authentication is username and password.** Each person has an individual
account and may sign in from any supported browser or computer. There is no
numeric PIN, no device registration, no trusted-machine behaviour, and no
per-computer state of any kind.

- Passwords are hashed with Argon2id and are never stored, logged, or echoed in
  any other form. Minimum 10 characters, maximum 128, **no composition
  requirements**.
- Usernames, not email addresses, are the login identifier. Nobody in the shop
  has a work address, an email-based reset would depend on an inbox the business
  does not control, and an address collected "for later" is a personal detail
  stored for no current purpose.
- Sessions remain **server-side rows** behind an `httpOnly`, `Secure`,
  `SameSite=Lax` cookie, exactly as ADR 7 decided. The database stores only a
  hash of an opaque token, never the token itself.
- A session row records **no IP address and no user agent**, superseding that
  bullet of ADR 7. Technical request metadata belongs in audit and security
  logging, on its own retention schedule, per ADR 9.
- A session carries **no capability snapshot**. Capabilities are resolved from
  the user's current role on every request, so a role change or a deactivation
  takes effect on the next request without rewriting session rows.
- Users are **deactivated, never deleted**.
- The first owner is created by a one-time operator command
  (`npm run identity:create-owner`). No credential — not even a default one —
  is committed to this repository or seeded by a migration.

Still open, and deliberately not decided here: session lifetime and idle
timeout, whether the one-tap "switch user" affordance from ADR 7 survives, rate
limiting, and lockout. Those belong to the PR that builds the login route, where
they can be chosen against a real form rather than in the abstract.

## Consequences

- A credential with real entropy behind it, so the login route is not depending
  on rate limiting to be safe.
- Anyone can work from any machine, in the shop or abroad, with no registration
  step and nothing to migrate.
- Accepted cost: a password is slower to type at a busy counter than a PIN, and
  people will pick weak ones anyway. The minimum length is what pushes toward a
  passphrase; composition rules would push toward `Password1!`.
- Accepted cost: with no email, a forgotten password is reset by someone holding
  `identity.manage` — in practice the owner, who may be in another country. That
  is a support path, not a self-service one, and it is why `SUPER_ADMIN` exists.
- ADR 7's shared-laptop reasoning is now recorded in two superseded ADRs. Read 9
  and 10 together: the machine is not an identity, and the person's credential
  has to survive being on the open internet.
