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

A capability is not a destination, either: an entry arrives with its screen and
not before, so `identity.manage`, `audit.read`, and `reports.export` still offer
nothing. Receiving is gated on **`inventory.receive`** alone — reading stock and
booking it in are different permissions, and somebody holding only the first
must not be shown a door the API will shut.

**A hidden link is not a security boundary.** Capabilities arrive from `/me` and
live in a browser, where anything can be edited. Every request is checked again
by the server, which is the authority. Hiding a link somebody cannot use is a
usability property and nothing more.

## Receiving

The first screen in this application that changes anything. An employee holding
`inventory.receive` books in a delivery: **one variant, one location, one whole
positive quantity, one arrival time.** It is not purchasing — there is no
supplier, no order, no invoice, no cost, and no receipt document. The movement
the server records _is_ the business record.

```
src/screens/ReceivingScreen.tsx   the form, its states, and the operation id
src/lib/receiving.ts              active choices · variant labels · local time · validation
src/lib/receivingApi.ts           POST /api/inventory/receive, typed by the shared schemas
```

**A retry is safe, and that is the point.** The operation id names the _intent_
— this delivery, this many, here, at this time — and is generated once when a
receipt begins, never per attempt. Every retry sends the same id and the same
fields, so the server recognizes the repeat and answers with the movement it
already posted. Which makes the honest instruction to somebody who does not know
whether their receipt went through: press it again.

| What happens                       | What the id does                         |
| ---------------------------------- | ---------------------------------------- |
| the form opens                     | a new UUIDv7                             |
| the button is pressed              | unchanged                                |
| the connection drops, then a retry | unchanged — the same command, sent again |
| **Receive another item**           | a new one                                |
| **Start a new receipt**            | a new one                                |

While a request is in flight the form is disabled, and after a failure it stays
disabled until the person chooses: **retry the same receipt**, or **start a new
one**. Editing a field under an id whose outcome is unknown would turn a safe
retry into a conflict, so the choice is explicit rather than implied by typing.
A retry is offered only where sending the same thing again could work — a
dropped connection or a server fault. A refused item, a closed counter, or an id
already used for a different command is answered by starting again.

**Nothing is written to browser storage.** No draft, no operation id, no form
state. A shared shop laptop that remembered a half-finished delivery would show
it to whoever sat down next.

**The server owns identity.** The request carries the operation id, the variant,
the location, the quantity, and the arrival time — and nothing else. Who
received the stock comes from the session cookie; the movement id, the recorded
time, and the resulting quantities are the ledger's.

**The arrival time is business time**, not the moment the server recorded it. It
is prefilled with the browser's current local time, converted to an instant on
submission, and a time in the future is not refused: a shop laptop whose clock
is a few minutes fast must not block a delivery sitting on the counter.

Only active products, active variants, and active locations are offered, and a
selection that stops being offered is dropped rather than silently sent. The
screen reads the catalog and the locations it already had; it adds no balance
query, and it invalidates nothing after a success — receiving changes neither
the catalog nor the list of counters. **The visual design is still temporary**,
like every other screen here.

## Routing

There is none, deliberately. One authentication boundary, and inside it a shell
that swaps its main panel between four temporary screens. A router would buy
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

- **stock quantities.** Receiving reports the balance the server answered with,
  and nothing else reads one: there is no balance API, no stock screen, and no
  low-stock warning;
- adjustments, physical counts, reversal, and stock removal;
- no user management, no password change, and no password reset;
- no audit log, no reports, no notifications;
- offline operation. Connectivity failures are visible and a retry is safe, but
  nothing is queued and nothing survives a closed tab. The draft helpers in
  `lib/operations.ts` predate receiving and are unused by it — receiving
  persists nothing;
- the final visual design.

Receiving is the first inventory workflow that works end to end. Full production
deployment is reviewed now that it does — see
[docs/06-operations/deployment.md](../docs/06-operations/deployment.md).
