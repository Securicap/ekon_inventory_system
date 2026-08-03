# `audit` module

**Owns:** `audit_events`

**Responsibility:** attributable record of significant state changes that are
not inventory movements — product and variant creation and deactivation, user
creation and deactivation, PIN resets, successful and failed logins, session
revocation, movement reversal, and count posting.

Kept separate from `inventory_movements` on purpose: stock changes need
arithmetic guarantees and are queried by variant, while audit events need
breadth and are queried by actor and time. One table serving both access
patterns would serve both badly.

Arrives in the audit PR.
