# `frontend`

React + TypeScript, built into `backend/public` and served by the backend from
the same origin. The browser is a client and holds no authoritative data.

**The current screens are temporary.** The platform's visual design has not been
done. What is here is plain semantic HTML with enough Tailwind to be usable at a
shop counter and on a phone: no design system, no component library, no icon
set, no theme architecture, and no dashboard. It is meant to be replaced whole,
and it is deliberately small enough that replacing it is cheap.

## Signing in

Browser authentication works. Somebody can open the application, sign in, use
the screens that exist, and sign out.

```
src/auth/
  AuthProvider.tsx     the four-state answer to "who is signed in"
  AuthBoundary.tsx     loading · login · recoverable error · the shell
  LoginScreen.tsx      username, password, one message for a rejected credential
  SignOutButton.tsx    asks the server to revoke, then drops everything
  authApi.ts           login · logout · getCurrentUser
  useProtectedQuery.ts a read that requires a session, and what a 401 means
  capabilities.ts      hasCapability(user, capability)
```

**The server session is the source of truth.** On every page load the
application calls `GET /api/auth/me` and renders nothing protected until it has
an answer. A refresh restores the user the same way. Nothing about the session
or the user is written to `localStorage`, `sessionStorage`, IndexedDB, or a
cookie created here — a copy in the browser would be a second answer to "who is
this", it would survive a revocation, and it would still be there after somebody
walked away from the shop laptop.

**The frontend never sees a token.** The session cookie is `HttpOnly`, so
JavaScript cannot read it; `credentials: 'same-origin'` in `lib/api.ts` is the
whole of the client's part in carrying it. There is no `Authorization` header,
no JWT, and nothing to store. Login and logout carry no operation id: signing in
is not a ledger command, and replaying it must mint a new session rather than
return the earlier one.

**Four states, not `user | null`.** `loading`, `authenticated`,
`unauthenticated`, and a recoverable `error` — because `null` cannot say whether
we are still asking, and an application that cannot tell those apart flashes a
shell at somebody who is not signed in, or shows a login form to somebody who
is. An unreachable server during bootstrap is its own state with a retry button:
a dropped connection is not evidence that nobody is signed in, and must not
invite somebody to type a password into it.

**A rejected credential has one message.** An unknown username, a wrong
password, and a deactivated account are all `401` from the server and all read
the same here — anything else would turn the form into a way to ask which
usernames exist.

### 401 and 403 are different

| From a protected request | What the application does                                   |
| ------------------------ | ----------------------------------------------------------- |
| `401`                    | the session ended: drop every protected query, show login   |
| `403`                    | say so in place; the person stays signed in and can move on |

A `403` is not a session problem, and signing in again would change nothing
about it. Both go through `useProtectedQuery`, which is the only join between
the generic API client and React — `lib/api.ts` knows about HTTP and nothing
about who is signed in.

## Navigation

Visibility is decided by **capability, never by role**. There is no
`user.role === 'OWNER'` anywhere in this package; the backend authorizes the
same way, and a screen that branched on a role name would be a second, quietly
different answer that a change to `role_capabilities` would never reach.

A capability is not a destination, either. `inventory.receive` is granted to
every employee and enforced by the API, but there is no receiving screen yet, so
nothing offers one — and the same goes for `identity.manage`, `audit.read`, and
`reports.export`. Entries arrive with their screens.

**A hidden link is not a security boundary.** Capabilities arrive from `/me` and
live in a browser, where anything can be edited. Every request is checked again
by the server, which is the authority. Hiding a link somebody cannot use is a
usability property and nothing more.

## Routing

There is none, deliberately. One authentication boundary, and inside it a shell
that swaps its main panel between three temporary screens. A router would buy
addressable URLs for screens that are about to be replaced, and would have to be
replaced with them. A hard refresh still works: the backend's single-page
fallback serves `index.html` for any non-`/api/` path.

## Translations

Every user-facing string lives in `src/i18n/ht.json` and `src/i18n/fr.json` —
Haitian Creole is the primary employee-facing language (ADR 8) and French is for
the owner. A string baked into JSX is a string that will never be translated;
`scripts/check-conventions.mjs` fails the build on one, and a test asserts both
catalogues carry the same keys. Capability names are never shown to a user.

## Data

TanStack Query, with defaults tuned for an unreliable connection in
`app/providers.tsx`: reads retry, writes never do. `/api/auth/me` is a query
like any other, asked once per page load — there is no polling and no periodic
`/me`, because a revocation lands on the next protected request the person
makes, which is the moment it matters.

## Still missing

- **receiving** — no screen and no API. It is the next milestone, and the first
  end-to-end inventory workflow;
- no user management, no password change, and no password reset;
- no audit log, no reports, no notifications;
- offline operation. Connectivity failures are visible and form drafts survive
  in `localStorage` with a retry-stable operation id (`lib/operations.ts`), but
  there is no queue;
- the final visual design.

Full production deployment is deferred until the first inventory workflow works
end to end — see [docs/06-operations/deployment.md](../docs/06-operations/deployment.md).
