# `identity` module

**Owns:** `users`, `sessions`, `devices`, `role_capabilities`

**Responsibility:** who is acting, from where, and what they are permitted to do.

Authentication is username + numeric PIN, not email + password: employees share
a shop laptop and need fast switching, and there is no email to reset against.

Sessions are server-side rows, not stateless tokens, because the laptop is
shared and also used for unrelated work — that requires instant revocation and a
short idle timeout, neither of which a stateless token provides.

Exposes `requireCapability(actor, capability)`. No other module may read these
tables directly.

Arrives in the identity PR.
