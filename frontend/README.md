# `frontend`

React + TypeScript, built into `backend/public` and served by the backend from
the same origin. The browser is a client and holds no authoritative data.

**The visual design has not been done.** What is here is plain semantic HTML
with enough Tailwind to be usable at a shop counter and on a phone: no design
system, no component library, no icon set, no theme architecture, and no
dashboard. The _information architecture_, though, is no longer temporary — it
is the OR1 operating model made visible, and the rest of this file is mostly
about why it is shaped the way it is.

The shop's whole loop is reachable without a terminal: enter merchandise, book a
delivery in, read what is on the shelf, record what leaves, walk the shelves and
record what was found, explain a difference and let the shop's numbers move,
correct a number that was wrong, undo a movement that should not have been
posted, and withdraw merchandise the shop no longer sells.

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

## Products and Inventory are not the same thing

This is the distinction the interface exists to make obvious, because it is the
one that confused people first.

**Products is the catalog: what the shop sells.** A brand, a name, how it is
classified, the variants it comes in, what each sells for and what each cost.
There is **no quantity anywhere on it** — not a total, not a location, not a
"currently 7 in stock" under the price. A product exists whether or not a single
unit is on a shelf, and it goes on existing after the last one is sold.

**Inventory is the shelf: what the shop physically holds.** A SKU, a quantity, a
location. It is a projection of the ledger, it changes every time anything
moves, and it never carries a price — a shelf count is not a valuation, and a
screen that put the two together would be inviting somebody to multiply them and
call the answer money.

Everything downstream follows from the split:

- entering merchandise is a catalog act (`catalog.write`) and moves no stock;
- withdrawing merchandise is a catalog act (`catalog.deactivate`) and moves no
  stock — archiving is _refused_ while stock remains rather than writing it off;
- receiving, removal, adjustment, reversal and reconciliation are inventory acts
  and all of them post to the ledger.

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
door opens on the read capability or on the other's.

**Counts and History ride on `inventory.read`.** Seeing what has been counted
and how the numbers got here is inventory _visibility_; recording a count and
accepting a difference need `inventory.count`, and those are gated on the screen
rather than at the door. Somebody who may read stock and nothing else opens both
screens and can change neither.

### Some capabilities open no destination at all

`inventory.adjust`, `inventory.reverse` and `catalog.deactivate` add nothing to
the navigation, on purpose. **A capability is not a destination.** Each of the
three is an action _on_ something:

| capability           | where it lives                                   |
| -------------------- | ------------------------------------------------ |
| `inventory.adjust`   | the inventory row whose number is wrong          |
| `inventory.reverse`  | the movement in History that should not be there |
| `catalog.deactivate` | the product on Products being withdrawn          |

Making any of them a screen would mean asking somebody to arrive at a blank form
and re-identify the thing they were already looking at — and, worse, would put
"correct a balance" beside "record a sale" in a list of everyday acts, which is
exactly the confusion the two capabilities exist to prevent.

### Three groups

The sidebar reads as three short lists rather than one long one, split by what
somebody came to do:

- **Operations** — Home, Inventory, Receive, Remove: running the shop today.
- **Control** — Counts, History: checking that today's numbers are right.
- **Management** — Products, New account: deciding what the shop sells and who
  may touch it.

A group whose entries are all forbidden does not appear at all, heading
included.

**A hidden link is not a security boundary.** Capabilities arrive from `/me` and
live in a browser, where anything can be edited. Every request is checked again
by the server, which is the authority. Hiding a link somebody cannot use is a
usability property and nothing more.

**`catalog.write` opens no door of its own.** It is an action _on_ the products
screen rather than a screen beside it, because the list is the confirmation: a
product created is a product visible one line below the form that made it.
Reading the catalog and writing it are still two permissions, and somebody
holding only `catalog.read` — every employee — is shown the list and no form.

## Entering merchandise

**A product, its brand, how it is classified, and one or more variants.** Each
variant carries its attributes, what it sells for, what it cost, and any barcode
somebody else printed on it. A variant with no attributes is the default
variant, which is the ordinary case for something sold one way, and is what
"type a name and press create" still produces — every field beyond the name is
optional, because a shop that does not know a price yet must not be blocked from
entering the item.

**Attribute names are a list, never a text box.** `color` is the shape variant
identity takes across the whole catalog — it is baked into the variant
signature — so the server refuses a name it has never heard of. A form that
invited somebody to type one would be a form that invites a rejection they had
no way to predict, and a shop that got past it would end up with `color`,
`colour` and `couleur` describing the same thing. The vocabulary comes from
`GET /api/catalog/metadata`; the _value_ stays free text, because `Black` is
display data about one variant.

**Money is entered as money and converted at the edge.** `7,500.00`, not
`750000`. The conversion in `lib/money.ts` reads the digits as _text_ and pads
them — there is no floating-point arithmetic anywhere in the parse, because
`7500.55 * 100` is `750054.99999999999` in JavaScript and `Math.round` would
paper over that for most inputs and lose a centime for some. The currency is
chosen per amount rather than assumed: this shop buys in one currency and sells
in another routinely, there is no configured default anywhere in the system, and
a form with a hard-coded `HTG` would be quietly wrong about half the
merchandise. An amount with no currency, or a currency with no amount, is
refused; an empty price is **omitted** rather than sent as zero, because `null`
means nobody has established one and zero would mean the item is free.

**Nothing the server owns has an input**, and none could be sent if it had one.
The request goes through the shared `.strict()` `createProductRequestSchema`
before it leaves — the same parse the route performs — so an `id`, a
`variantSignature`, or a `sku` is refused in the browser rather than after a
round trip. The SKU above all: it is generated by the catalog and is the one
identifier printed on a shelf label.

**Attribute names and values are sent as they were typed.** The catalog trims
them and lower-cases for identity on arrival, and doing any of that here as well
would be the browser deciding something the server is the authority on. The one
rule the form applies for itself is refusing the same attribute name twice in a
variant — attributes cross the wire as a JSON object, so a repeat would collapse
into one key here and the server would never learn the second was typed.

**A product is not a ledger command, and this is where that shows.** Receiving
may be pressed again after a dropped connection because the operation id makes
the server recognize the repeat. There is no such contract on
`POST /api/catalog/products` and no uniqueness on a product name, so a second
attempt after an uncertain answer is a second product. Nothing retries
automatically (`mutations: { retry: false }`), a second press while the request
is open is ignored, and a dropped connection or a `5xx` is said as **"we do not
know"** — with a button that re-reads the list, which is where the answer
actually is, rather than one that invites a duplicate. A `409` is the one
refusal phrased specifically: those attributes already exist.

A confirmed `201` closes the form, names the product and the SKUs the server
chose, and invalidates `catalogProductsQueryKey` — which is what makes the new
item appear in the list _and_ selectable on receiving, with no reload.

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
ahead of us**, like every other screen here.

## Current stock

The Inventory destination answers the question the counter asks all day: **what
do we have, and where is it?** It is gated on **`inventory.read`**, and it is
the screen the old location list became — locations are not a destination of
their own, because their names arrive inside the stock answer. It carries no
price and no cost: a shelf count is not a valuation, and see _Products and
Inventory are not the same thing_ above.

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

**The rows now lead somewhere, and only where a capability allows.** Three
actions at most, each on its own key, each absent rather than disabled when it
is not held:

| action  | capability         | what it does                                    |
| ------- | ------------------ | ----------------------------------------------- |
| History | `inventory.read`   | opens History already filtered to this SKU      |
| Count   | `inventory.count`  | opens the count form with item and shelf chosen |
| Correct | `inventory.adjust` | opens the adjust dialog on this row             |

**Receive and Remove are deliberately not among them** even though they would
fit. Both have their own destination, both are everyday work with their own form
and their own outcome, and duplicating them onto every row would give one act
two front doors that behave differently. What a row shortcut is good for is the
thing that is _awkward_ from a destination: opening history already narrowed to
this SKU, or counting the shelf you are looking at.

A greyed-out button is a door with a lock on it; this application does not show
those. A variant held at no active location offers History and nothing else,
because a count and a correction are both per (item, shelf) and there is no
shelf for them to be about.

Still deliberately absent from the rows: the variant, product, and location ids,
and `updatedAt`. That last one says when a projection moved, not when anybody
counted, and a screen that showed it as a business fact would invite somebody to
trust it as one.

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
still ahead of us**, like every other screen here.

## Physical counts

> **A count observes. Investigation explains. Reconciliation changes stock.**

The Counts screen is built around that sentence, and it is worth saying how,
because the tempting design breaks it.

**Recording a count changes nothing.** Not the balance, not the ledger, not this
screen's own stock figures — and the form says so out loud above the fields,
because every other inventory screen a person has used _does_ change them. The
variance that comes back is evidence; it sits in the list below marked as
needing review, and it stays there until somebody with `inventory.count` accepts
it and says why.

**The form does not show what Ekon expects.** Not because this is a blind
count — blind counting is a post-OR1 workflow with locking and second counts,
and none of that is here — but because a number printed beside the box you are
about to type in is an invitation to agree with it. Somebody who walks a shelf,
finds six, and sees `7` on the screen types 7 more often than they should, and
the discrepancy that would have told the shop something disappears. The
comparison comes _after_ submission, from the server, which is also the only
place it can honestly come from: the expected quantity is read inside the
recording transaction and the browser never has it.

**Zero is a real observation**, and the hint says so. An empty shelf is exactly
the count that matters most, and a form that looked like it wanted a positive
number is a form somebody skips when the shelf is empty.

**The three numbers are never recomputed.** A count taken last Tuesday says what
it said last Tuesday even though the shelf has moved since. It is evidence about
a moment, not a view of the present, and a list that re-derived the variance
against today's balance would rewrite that evidence every time the shop traded.

### Accepting a difference

The reconciliation dialog says:

> This will adjust inventory by −1.

and it must never say:

> This will set inventory to 6.

The second is what a reader assumes and it is **wrong**. Six was true when the
shelf was walked; if a unit sold in the hour since, the shelf now holds five and
accepting a difference of one leaves four. The server applies the observed
_difference_ to the current balance — the only arithmetic that keeps every
legitimate movement posted in between — and a dialog that promised a destination
would be promising a number the system will not produce.

A reason is required, because a stock change nobody explained is exactly what
the count principle exists to prevent, and `OTHER` demands a note because it
explains nothing on its own. There is deliberately no "the count was wrong" in
the vocabulary: a mistaken count is corrected by counting again, not by
accepting a difference nobody believes in.

### What each act invalidates

This is the invalidation rule the whole workflow rests on, and it is the one
place a well-meaning `invalidateQueries` would quietly break the principle:

| act               | counts | balances | movements |
| ----------------- | ------ | -------- | --------- |
| recording a count | yes    | **no**   | **no**    |
| reconciling one   | yes    | yes      | yes       |

Recording a count posts no movement and moves no stock. Re-reading the balances
afterwards would be the screen quietly implying that something changed on the
shelf.

## Stock history

The evidence screen. Every other screen answers _what is true now_; this one
answers _how it got that way_, which is the question somebody asks when the two
disagree.

**`before → after` is shown, not just the delta.** The delta says what changed;
the pair says what the shelf held on either side of it, which is what somebody
reconstructing a discrepancy actually needs. Both come from the ledger row and
neither is computed in the browser — the arithmetic was settled when the
movement was posted, and recomputing it here would be inventing a second answer.

**A sale leads with its reason, not its mechanism.** An `ISSUE` reads as _Sold_
rather than _Stock removed_, because sold, broken and taken for the shop's own
use are three different things and a feed that collapsed them would hide exactly
the distinction the ledger keeps a reason column for. Everything else leads with
its type, with the reason beside it.

**Relationships are shown in words, never as ids.** A movement that was undone
is marked as such — otherwise somebody scrolling past a receipt of 10 reads it
as stock the shop received and goes looking for where it went. A reversal says
it is one, and a movement that came from a count says so, which is what turns a
reconciliation from an unexplained stock change into evidence.

**Labels are current, not historical.** The ledger stores ids; the product name,
the location name and the person's name are resolved by the server from the
tables that own them today. A product renamed last week changes what an old
movement _displays_ while the movement still refers to the same variant and SKU.

**Pagination is a cursor and a "load more" that appends**, never page numbers:
the ledger grows at the front, so page four means something different every time
a receipt is booked in. The filters are the item, the shelf, and the kind of
movement — chosen by name, with the uuid going over the wire without ever being
shown. There is deliberately no date range: the feed is newest-first, and two
more controls between somebody and the row they want is the cost of a filter
nobody asked for.

### Reversing a movement

**The dialog never says _delete_, _undo_, or _remove record_,** because none of
those is what happens: the original stays in the ledger exactly as it was and a
compensating movement is appended beside it. Somebody who thinks they erased a
mistake will be surprised later by a history that still shows it, and a person
surprised by their own inventory system stops trusting it.

It also says the thing that is easy to get wrong: a reversal moves **current**
stock. Reversing a receipt of ten takes ten off the shelf as it is now, not off
the shelf as it was that morning — and if the shop has sold some since, the
server refuses rather than letting the shelf go negative.

The button is drawn only where the ledger's own rules allow it (INV-2): a
`REVERSAL` may not be reversed, and a movement that has already been reversed
may not be reversed again. It deliberately does **not** try to predict the stock
floor — that depends on a balance this screen does not have and must not guess
at, and the refusal is rendered when it comes back.

## Correcting a number

**Adjusting is not Removing, and the dialog works hard to say so.** Removing
records that units left the shelf — sold, broken, taken for the shop's own use.
Adjusting records that nothing happened at all and the _number_ was wrong: a
delivery entered twice, a sale rung up while the system was down, a mis-keyed
receipt. They move the same stock and mean opposite things in a history,
permanently, which is why they are different capabilities and why this is a
small dialog attached to the row whose number is wrong rather than a third entry
beside Receive and Remove.

It is also not a count. A count observes the shelf and leaves evidence; an
adjustment states a correction with no observation necessarily behind it. If
somebody walked the shelf and found six, the honest workflow is Counts.

**Nobody types a minus sign.** The form asks _which way_ and _how many_, and
`lib/adjustment.ts` turns the pair into the signed delta the contract wants —
exactly one place in the browser knows that "fewer" means a negative number. The
sentence above the button then says what will actually be sent, so the
translation happens in front of the person rather than behind them.

## Withdrawing merchandise

Three states, in plain words rather than as a state machine:

| status           | what it means for the shop                                                 |
| ---------------- | -------------------------------------------------------------------------- |
| **Active**       | sold and restocked normally                                                |
| **Discontinued** | no longer restocked; what is on the shelf still sells and is still counted |
| **Archived**     | out of day-to-day use, kept for history                                    |

The consequence is spelled out before the change, because both of the
interesting ones are easy to misread. _Discontinued_ sounds like gone and is
not. _Archived_ sounds like deleted and is not — the history stays, and the
server refuses it outright while any stock remains.

**Nothing here moves stock, in either direction.** If archiving is refused
because six are still on a shelf, this offers no button to write them off: that
would be a lifecycle screen posting an inventory movement, which is the one
thing a lifecycle change must never do. The refusal is shown as what it is, and
the remedy is to sell or correct the remaining stock somewhere that says so.

`ARCHIVED → ACTIVE` is not offered, because the server refuses it: coming back
into use and being restocked again are two decisions, so archived merchandise is
offered _Discontinued_ and somebody makes the second choice separately.

## Retries, and the operation id

Every command that posts to the ledger carries an operation id, and the rule is
the same everywhere: **the id is generated once, when the form or the dialog
opens, and reused by every retry of that command.** A fresh id per submit click
would turn the server's duplicate protection off from the outside — the retry
after a dropped connection would become a second receipt, a second correction, a
second count of one shelf.

A new id is taken only when the command is _settled_ and the next one is a
different fact: the count form takes one after a successful record, because the
next shelf is a different observation. A second press while the first request is
still open sends nothing at all.

## Three widths

Explicit presentations rather than one markup that hides columns with CSS. The
stock register is a real table on a desktop, a narrower table on a tablet, and a
list of records on a phone — three sets of markup, because a table with three of
its five columns display-noned is a table a screen reader still reads five
columns of.

Counts, History and Products are never tables at any width. A movement is six
facts that belong together, and six columns on a 390px screen is either a
sideways scroll or six illegible columns; the columns become rows as the screen
narrows. **Nothing scrolls sideways at any width.**

The phone's bottom bar carries the three everyday acts — Inventory, Receive,
Remove — and everything else lives behind More. The bar is bounded on purpose: a
bottom bar that grew with every new screen would end up unusable at exactly the
width it exists for. Counts and History are real destinations and they are one
press further away, which is the right trade for screens somebody opens a few
times a day rather than a few times an hour.

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
that swaps its main panel between eight screens — home, inventory, receiving,
removal, counts, history, products, and creating an account. A router would buy
addressable URLs while the visual design is still ahead of us, and every one of
them would have to be revisited with it. A hard refresh still works: the
backend's single-page fallback serves `index.html` for any non-`/api/` path.

What a router would otherwise have bought is carried instead by a small
`ViewFocus` passed alongside the destination: opening History from an inventory
row arrives _already filtered to that SKU_, and opening Counts from one arrives
with the item and the shelf already chosen. A destination somebody has to
re-identify the thing they were just looking at on is a destination they stop
using.

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
never written out twice. Invalidation matches on key equality, so two literals
would drift apart silently — the write would succeed, the numbers would stay
stale, and nothing would fail. The writes import the key, not the screen; a
write that had to pull in a component to learn what to invalidate would be a
dependency pointing the wrong way.

| key                                                  | read by                    | invalidated by                                         |
| ---------------------------------------------------- | -------------------------- | ------------------------------------------------------ |
| `inventoryBalancesQueryKey`                          | Inventory, Counts, History | Receive, Remove, Adjust, Reverse, Reconcile, Lifecycle |
| `catalogProductsQueryKey`                            | Products, Receiving        | Creating a product, Lifecycle                          |
| `countsQueryPrefix` (`['inventory','counts']`)       | Home, Counts               | Recording a count, Reconciling                         |
| `movementsQueryPrefix` (`['inventory','movements']`) | History                    | Adjust, Reverse, Reconcile                             |

The two feeds are keyed **by their filters** — `countsQueryKey({status:'OPEN'})`
is not `countsQueryKey({})` — because "everything" and "what is still open" are
two different questions and must not share a cache entry. Writes invalidate by
_prefix_ rather than by exact key, so the change is visible under whichever
filters anybody happens to have open. Home reads the open feed with the Counts
screen's own key, which is what makes arriving there show exactly what the
attention panel counted.

Successive pages of one feed are **not** keyed by cursor. They accumulate into
one cache entry in the screen's own state, because keying by cursor would make
each page its own entry that the first one could never invalidate.

## Still missing

- **analytics and alerting.** No dashboard, no charts, no low-stock threshold or
  colour, no reorder point, no valuation, no trend, no "sales this week". Every
  one of those is a number the business would read as true, and a made-up figure
  in an inventory system is not a placeholder, it is a lie somebody will act on.
  Home carries exactly one figure that is not a door — the count of unexplained
  count differences — and it earns its place by being _work_ rather than a
  metric;
- **anything a count session would need.** No scope, no campaign, no blind
  count, no second count, no locking, no approval queue. One observation covers
  one item at one location;
- **suppliers and purchase orders.** Receiving records that stock arrived, and
  nothing about who it came from or what was ordered;
- **barcode scanning.** Barcodes are typed and stored; there is no camera, no
  symbology library, and no check-digit rule;
- **any sales domain.** `SOLD` is a removal reason. There is no sale, order,
  customer, payment, tax, receipt, or refund, and none is planned here;
- **catalog management beyond entering merchandise and withdrawing it.** No
  editing, no renaming, no adding a variant to a product that exists, no
  managing the brand or classification vocabularies, and no search or paging
  over the list;
- **user management beyond creating an account.** The one screen creates a
  person and stops: no list, no search, no editing, no role change, no
  deactivation, no password change, and no password reset. Each is a separate
  authority over somebody's access, and none of them blocks running the shop;
- **reports and export.** No CSV, no printing, no scheduled anything. `audit.read`
  and `reports.export` still open no door, because a link to a screen that does
  not exist is worse than a missing link;
- offline operation. Connectivity failures are visible and a retry is safe, but
  nothing is queued and nothing survives a closed tab;
- the final visual design.

The OR1 loop is closed in the browser, end to end, with no step that needs a
terminal: after the owner bootstrap, the owner signs in, creates the employees'
accounts, and enters the shop's merchandise; an employee books in a delivery,
reads the number it produced, records what leaves, walks the shelves and records
what was found, and somebody with the authority explains the difference and lets
the shop's numbers move — with a correction and a reversal available for the two
kinds of mistake, and merchandise withdrawn when the shop stops selling it. On
the same laptop or the same phone, in their own language, with every retry safe.
Full production deployment is reviewed now that it is — see
[docs/06-operations/deployment.md](../docs/06-operations/deployment.md).
