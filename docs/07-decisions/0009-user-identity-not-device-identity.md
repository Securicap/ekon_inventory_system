# 9. The permanent actor is the authenticated user, not the device

**Status:** Accepted — 2026-08-03. Supersedes the `device_id` part of ADR 6.

## Context

ADR 6 committed to capturing a `device_id` — a UUIDv7 generated once per browser
installation and kept in `localStorage` — on every movement and audit event. Two
arguments were given: attribution ("which machine recorded this?"), and that
device identity cannot be backfilled onto history, so it had to be captured from
the first release even though nothing consumed it.

Neither survives contact with how the shop actually works. Employees sign in on
whichever computer is free, sometimes several people on one machine in a shift,
sometimes one person across two. The owner works from abroad on a different
machine again. Nothing anyone asks about stock — who received this delivery, why
did this count come up short, when did we last have any left — is answered by
naming a browser installation.

The second argument was the more persuasive one, and the more wrong. It is true
that the value could not be backfilled. It could not be backfilled because it
never carried meaning, and a field with no meaning does not become meaningful by
being old. Capturing data on the chance it turns out to matter is exactly how a
permanent ledger accumulates columns nobody can interpret and nobody dares drop.

The cost of being wrong here was about to compound: authentication and the
receiving workflow are next, and both would have been built to carry a device
identity through their contracts.

## Decision

Device identity is not part of authentication, authorization, inventory
ownership, inventory attribution, the permanent stock ledger, or the receiving
workflow.

**The permanent business actor is `user_id`**, populated from trusted
server-side authenticated context once authentication exists. Users may sign in
securely from any supported browser or computer. Whether several users share one
computer, or one user works from several, has no business significance and is
not modelled.

Removed: `inventory_movements.device_id` (migration 0006), the
`x-ekon-device-id` header, the browser-generated id in `localStorage`, and the
request decoration that read it. Nothing replaces it — no terminal, session, IP,
or user-agent column on a movement.

Technical request metadata — IP address, user agent, request id, session id —
may later be captured in **audit and security logging**, where it answers
security questions and can be retained on its own schedule. It does not belong
in the stock ledger, which is business history.

Still standing from ADR 6, unchanged: application-generated UUIDv7 identifiers,
retry-stable operation ids, `occurred_at` (business time) distinct from
`recorded_at` (server time), and offline synchronization as a deferred milestone.

## Consequences

- An employee can work from any machine in the shop, or from a replacement
  laptop, with no registration step and nothing to migrate.
- The identity PR has one less concept to authorize against, and the receiving
  workflow has one less field to thread through its contracts.
- If offline synchronization eventually needs client-instance metadata — a queue
  id, a client sequence number — it will be designed from concrete
  synchronization requirements when that milestone begins, and it will most
  likely belong to the sync envelope rather than being welded into permanent
  stock history.
- Accepted cost: "which machine entered this?" is unanswerable, for history
  before and after this decision. Nobody has asked it, and if the question ever
  becomes real it is a security question, which is what audit logging is for.
