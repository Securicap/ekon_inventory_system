# `identity` module

**Owns:** `users`, `sessions`, `role_capabilities`

**Responsibility:** who is acting and what they are permitted to do.

Not _which machine_ they are acting from. There is no device registry and no
browser identity: an employee signs in from whichever computer is free, and
the permanent actor on a movement is the authenticated user (ADR 9). A
session records its IP and user agent for revocation and security review;
that is security metadata, not business attribution.

Authentication is username + numeric PIN, not email + password: employees share
a shop laptop and need fast switching, and there is no email to reset against.

Sessions are server-side rows, not stateless tokens, because the laptop is
shared and also used for unrelated work — that requires instant revocation and a
short idle timeout, neither of which a stateless token provides.

Exposes `requireCapability(actor, capability)`. No other module may read these
tables directly.

Arrives in the identity PR.
