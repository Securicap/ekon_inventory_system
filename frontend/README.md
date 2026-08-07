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
not before, so `audit.read` and `reports.export` still offer nothing. Receiving
is gated on **`inventory.receive`** alone — reading stock and booking it in are
different permissions, and somebody holding only the first must not be shown a
door the API will shut.

**`identity.manage`** opens exactly one door, and a narrow one: creating an
account. It is labelled for that act rather than for the subject, because a link
called "Users" that cannot list any would be a lie about what is behind it.

Each inventory door has its own key, and the keys are not interchangeable:
Stock on **`inventory.read`**, Receiving on **`inventory.receive`**, Removal on
**`inventory.remove`**. Somebody may hold any combination, and neither write
door opens on the read capability or on the other's. `inventory.adjust` opens
nothing at all — correcting a balance that was wrong is not recording that stock
left, and that screen does not exist.

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
screen reads the catalog and the locations it already had, and adds no balance
query of its own.

**A confirmed receipt invalidates the current-stock read**, and that is the only
thing it invalidates. Receiving creates no product and opens no counter, so the
catalog and the location list are left alone; what it does change is the number
the stock screen exists to say. The invalidation happens after the confirmation
is on screen and its failure is swallowed on purpose — the movement is permanent
the moment the server answers `201`, and tidying a cache must never turn a
booked delivery into "did that work?". A replay of an earlier receipt answers
`201` too and invalidates identically. A refusal and a dropped connection
invalidate nothing: nothing is known to have moved. **The visual design is still
temporary**, like every other screen here.

## Current stock

The Stock destination answers the question the counter asks all day: **what do
we have, and where is it?** It is gated on **`inventory.read`**, and it is the
screen the old location list became — locations are not a destination of their
own, because their names arrive inside the stock answer.

```
src/screens/InventoryScreen.tsx   the cards, the search, the refresh, the empty states
src/lib/inventoryQueries.ts       the balance read, and the query key two screens share
src/lib/stock.ts                  client-side search over what the server already sent
src/lib/variants.ts               how a variant's attributes are said, here and in receiving
```

**One read, and it is enough.** `GET /api/inventory/balances` already carries
the product name, the SKU, the attributes, and every active location's name, so
this screen does not fetch the catalog and does not fetch the location list.
Assembling the same picture out of three requests would be two more round trips
on a bad connection and three chances for the pieces to disagree. The response
is parsed with the shared schema on the way in, like a receipt's is.

**Every active location is shown, including the empty ones.** A zero is an
answer — "there is none in the Main Store" — and a shelf dropped for being empty
reads as a shelf that does not exist, which sends somebody to the wrong end of
the shop. The default location is marked with a translated word, never a colour.

Three answers with nothing in the list, kept apart, because they need different
things done about them:

| What came back                 | What the screen says                        |
| ------------------------------ | ------------------------------------------- |
| `[]`                           | no active product is available to stock yet |
| a variant with `locations: []` | the row, and: there is no active location   |
| a search that matched none     | nothing matches this search                 |

The last one is not the first one. A shop with stock that a search missed is not
a shop with no stock, and telling somebody the wrong one sends them to fix the
wrong thing.

**The search is entirely in the browser**, over a response the server already
sent in full: product name, SKU, attribute names, and attribute values, matched
case- and accent-insensitively so a keyboard without `è` still finds `gwosè`.
For a single shop the whole active picture is small and bounded; a request per
keystroke on a connection that drops would make the field unusable at exactly
the counter it is for. There is no search endpoint, no query parameter, and no
fuzzy-matching dependency. Location names are deliberately not searchable —
"everything in the backroom" is a different question, and a substring match
would answer it while still showing every other location's quantity.

**Refreshing is a button, not a timer.** No polling, no interval, no
subscription. Somebody presses it when they have reason to think the number
moved; it re-reads the balances alone, keeps what was typed in the search field,
leaves the numbers on screen while the new ones are on their way, and is
disabled while a read is in flight so it cannot be started twice.

**Nothing here changes anything.** No adjust, no removal, no count, no history,
and the cards are not clickable — a card that looked like a control would be
promising one that does not exist yet. Deliberately absent from the rows, too:
the variant, product, and location ids, and `updatedAt`. That last one says when
a projection moved, not when anybody counted, and a screen that showed it as a
business fact would invite somebody to trust it as one.

## Removal

The other half of the loop, and the last thing a counter needs to keep its
numbers honest: recording that stock **left**. One item, one shelf, one
quantity, one reason, one moment. Gated on **`inventory.remove`**, which every
role holds — including `EMPLOYEE`, because selling a bottle is what somebody at
the counter does all day.

```
src/screens/RemovalScreen.tsx   the form, its states, and the operation id
src/lib/removal.ts              choices · the shelf a form starts on · validation
src/lib/removalApi.ts           POST /api/inventory/remove, typed by the shared schemas
src/lib/businessTime.ts         one local-time conversion, shared with receiving
src/lib/variants.ts             one variant label, shared with receiving and stock
```

**It reads the balances and nothing else.** `GET /api/inventory/balances`, under
the same `inventoryBalancesQueryKey` the stock screen uses, because the question
this form asks is exactly the one that response answers: _which shelf am I
taking from, and how many are there now?_ No catalog read, no location read —
two more requests on a bad connection and three chances for the pieces to
disagree about which shelf holds what. Walking from Stock to Removal asks the
server nothing new.

**The numbers are advisory, and the screen never pretends otherwise.** They are
the last balance read; somebody else at the counter may take the last two
bottles in between. The server decides, under the row lock it already holds. So
the chosen shelf's quantity is stated plainly — _this location currently has
10_ — and never as "available", "reserved", or "on order", none of which this
system has.

| What the employee sees               | What it means                          |
| ------------------------------------ | -------------------------------------- |
| `Diri — gwosè: 5 mamit — EKN-… — 14` | the item, and its total across shelves |
| `Main Store — 10`, `Backroom — 4`    | each shelf, and what it holds          |
| an option greyed out                 | zero there; visible, not selectable    |

**Zero is shown and refused, never hidden.** An item at zero everywhere stays in
the list and cannot be chosen — dropping it would make a shop that is out of
rice look like a shop that never sold rice. A shelf at zero stays visible for
the same reason: an employee who cannot see that the Main Store is empty will go
looking for stock that is in the back. Neither can be selected, so nobody
travels to a guaranteed refusal.

**The form starts on the right shelf, or on none.** The default location when it
actually holds something; failing that, the only shelf with stock; otherwise
nothing. A default location holding zero is never preselected — it is the one
plausible-looking wrong answer, and it would open the form on a shelf that
cannot satisfy any quantity.

**Reasons are words on screen and codes on the wire.** `Yon kliyan achte l` /
`Vendu à un client` goes out as `SOLD`; nobody reads `INTERNAL_USE`, and no
report ever counts "Itilize nan biznis la". There is no free-text reason: one
somebody can type is one nobody can count. And `SOLD` is a reason a unit left
inventory — there is no customer, price, receipt, or payment anywhere in this
application.

**The operation id works exactly as receiving's does.** One intended removal,
one id, generated when the removal begins and sent unchanged by every retry.

| What happens                       | What the id does                         |
| ---------------------------------- | ---------------------------------------- |
| the form opens                     | a new UUIDv7                             |
| the button is pressed              | unchanged                                |
| the connection drops, then a retry | unchanged — the same command, sent again |
| **Remove another item**            | a new one                                |
| **Start a new removal**            | a new one                                |

After any failure the form freezes: the exact submitted command is kept, every
canonical field is disabled, and the way out is an explicit choice. Editing a
field under an id whose outcome is unknown would turn a safe retry into a
conflict.

**A shortfall is not an uncertain outcome, and is not offered a retry.** When
the server answers `422 INSUFFICIENT_STOCK` the transaction rolled back and the
stock did not move — sending the identical command again cannot work until the
command itself changes. So the screen says what happened, says what to do, and
re-reads the balances immediately so the corrected removal is chosen against
what is actually there. **A corrected removal is a new removal with a new id.**
Nothing is clamped, no quantity is silently reduced, no other shelf is chosen,
and nothing is resubmitted automatically.

The same immediate re-read follows a `404` and a `409` about an item or shelf:
all three mean the numbers on screen have moved. A dropped connection does not,
because nothing is known to have changed and the retry is still the right move.

**A confirmed `201` invalidates the shared balance key**, fire and forget, after
the confirmation is on screen and with its rejection swallowed — the movement is
permanent the moment the server answers, and tidying a cache must never reach
back and unsay it. Because the query is mounted on this very screen, the numbers
refresh in place. A replay of an earlier removal answers `201` too and
invalidates identically. Nothing else invalidates: not a `400`, `403`, `404`,
`409`, `422`, a dropped connection, or an unresolved `5xx`.

**Nothing is written to browser storage**, and nothing is optimistically
changed. Only the server's answer proves the stock moved. **The visual design is
still temporary**, like every other screen here.

## Creating an account

One form, behind **`identity.manage`**: a username, a full name, an initial
password, and a role. It is the whole of user management in this milestone and
is meant to stay that way — no list, no search, no editing, no role change, no
deactivation, no password reset. Each of those is a separate authority over
somebody's access, and none of them is what stops a shop opening for the day.
Creating an account is.

It exists as a screen rather than as a second operator command because the
command it would have joined is deliberately incapable of this. The bootstrap
creates one owner on an empty database and refuses everything else, precisely so
that there is no permanent unauthenticated path into `users` — a provisioning
command that could also create the tenth employee would be exactly that. This
workflow requires a session and a capability, which is what makes it safe, and a
signed-in workflow is a screen.

**Roles come from the shared `ROLES` vocabulary**, not a copy, and the select
offers all four — the server accepts the same closed set, so the list cannot
drift into offering a choice the API refuses. `EMPLOYEE` is preselected, because
it is what most accounts are.

**The password is typed here and never seen again.** It lives in component state
while it is typed and in the request body when it is sent, and nowhere else: not
in a query key, not in a URL, not in storage, and not in the confirmation, which
names the person and their username so they can be told those, and stops there.
The field warns before submission that it cannot be shown afterwards. This is a
shared laptop at a counter; a colleague's credential left on screen is a
credential on a counter. `autocomplete="new-password"` keeps the browser from
filing it under the signed-in person and offering it back at the login form.

Validation is the shared schema, so the form cannot accept what the server
refuses: the username is normalized before it is sent — `" Nadege.L "` is sent
as `nadege.l` — and the password is length-checked and never trimmed.

**A `409` is the one failure this screen phrases itself**, as "that username is
taken", because the remedy is to change one field. Everything else goes to the
shared `ErrorNotice`, which already says the right thing about `403`, a dropped
connection, and the unexpected. No operation id is sent: creating an account is
not a ledger command, and a repeat is a duplicate username the server refuses on
its own.

## Routing

There is none, deliberately. One authentication boundary, and inside it a shell
that swaps its main panel between six temporary screens — home, products,
stock, receiving, removal, and creating an account. A router would buy
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
makes, which is the moment it matters. Nothing in this application polls, and
nothing refreshes on a timer.

A query key that several screens depend on is **defined once and imported**,
never written out twice. `inventoryBalancesQueryKey` lives in
`lib/inventoryQueries.ts` and now has three users: Stock reads it, Removal reads
it _and_ invalidates it, and Receiving invalidates it. Invalidation matches on
key equality, so two literals would drift apart silently — the write would
succeed, the numbers would stay stale, and nothing would fail. The writes import
the key, not the screen; a write that had to pull in a component to learn what
to invalidate would be a dependency pointing the wrong way.

## Still missing

- **anything about stock beyond what is on the shelf now.** No movement history,
  no audit drawer, no low-stock threshold or colour, no reorder point, no
  valuation, no cost, and no supplier — and no sorting, paging, or export;
- **adjustments.** Removal records that stock _left_; an adjustment records that
  the _balance was wrong_, and it has its own capability, its own permanent
  movement type, and no API or screen at all. `inventory.adjust` opens nothing;
- physical counts and reversal;
- **any sales domain.** `SOLD` is a removal reason. There is no sale, order,
  customer, price, payment, tax, receipt, or refund, and none is planned here;
- **user management beyond creating an account.** The one screen creates a
  person and stops: no list, no search, no editing, no role change, no
  deactivation, no password change, and no password reset. Each is a separate
  authority over somebody's access, and none of them blocks running the shop;
- no audit log, no reports, no notifications;
- offline operation. Connectivity failures are visible and a retry is safe, but
  nothing is queued and nothing survives a closed tab. The draft helpers in
  `lib/operations.ts` predate receiving and are unused by it — receiving
  persists nothing;
- the final visual design.

Receiving, current stock, and removal close the operating loop: an employee
books in a delivery, reads the number it produced, and records what leaves — on
the same laptop, in their own language, with every retry safe. Full production deployment is reviewed now that it does — see
[docs/06-operations/deployment.md](../docs/06-operations/deployment.md).
