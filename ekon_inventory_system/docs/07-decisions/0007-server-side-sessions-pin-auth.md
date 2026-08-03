# 7. Server-side sessions and PIN authentication

**Status:** Accepted — 2026-08-02

## Context

Employees share one shop laptop that is also used for unrelated work. The value
of every audit record depends on the person at the keyboard being the person
logged in.

## Decision

Authentication is username + numeric PIN, hashed with Argon2id. Sessions are
rows in PostgreSQL behind an `httpOnly`, `Secure`, `SameSite=Lax` cookie — not
stateless tokens.

- 15-minute sliding idle timeout, 12-hour absolute expiry.
- No "remember me".
- The signed-in user's name is visible on every screen.
- One-tap "switch user".
- Sessions record IP and user agent; the owner can list and revoke them.

## Consequences

- A session can be revoked instantly. A stateless token cannot be, and on a
  shared machine that matters more than the database round trip costs.
- No email dependency, no password reset flow, no password manager on a shared
  machine.
- Attribution is trustworthy, which is what makes the audit log worth keeping.
- Frequent re-authentication is friction. The one-tap switch and the number pad
  are there to keep that friction from producing shared accounts, which would
  destroy attribution entirely.
