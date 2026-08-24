# `catalog` module

**Owns:** `products`, `product_variants`, `variant_attributes`, `brands`,
`classification_dimensions`, `classification_values`, `product_classifications`,
`variant_attribute_definitions`, `variant_barcodes`

**Responsibility:** what can be stocked, and the SKU that identifies it.

The merchandise model this module implements is
`Classification → Product → Variant/SKU`
([the domain document](../../../../docs/03-architecture/retail-domain-and-or1.md),
ADR 11). A **product** is the recognizable model and carries no stock — a brand,
a description, how the merchandise is classified. A **variant** is the smallest
independently sellable and stockable identity, and owns its SKU, price,
reference cost, barcodes, and inventory.

Inventory is stored per **variant**, never per product. Every product therefore
has at least one variant; a plain item is a single default variant with no
attributes. `variant_signature` (the normalized, sorted attribute set) carries a
uniqueness constraint per product so "White / Size 9" cannot be created twice.
It is **internal**: the column still exists and still enforces that rule, and it
is no longer on the wire — clients were always told to treat it as opaque, so
sending it invited them to stop.

SKUs are generated server-side, unique, and immutable — they end up on physical
shelf labels.

`variant_attributes` is a thin key/value table, and its names are now
**controlled**: they come from `variant_attribute_definitions`, and the database
refuses a new attribute under any other name
(`variant_attributes_name_defined_fk`, 0010). See
[Controlled attribute names](#controlled-attribute-names) for what that
constraint does and does not cover.

## Endpoints

### `POST /api/catalog/products` — create a product

Creates a product with its brand, classifications, variants, attributes, prices,
reference costs, and barcodes — in a **single transaction**. Returns
`201 Created` with the complete product, including the server-generated variant
SKUs. A failure anywhere leaves nothing behind, including a brand or a
classification value the request would have introduced.

```jsonc
// request — everything except `name` and `variants` is optional
{
  "name": "Bel Ami",
  "description": "Optional",
  "brand": "Steve Madden",
  "classifications": { "audience": "Women", "category": "Footwear", "type": "Sandals" },
  "variants": [
    {
      "attributes": { "color": "Black", "size": "8", "width": "M" },
      "sellingPrice": { "amountMinor": 249900, "currency": "HTG" },
      "referenceCost": { "amountMinor": 1800, "currency": "USD" },
      "barcodes": ["0885140123456"],
    },
  ],
}
```

**A brand is a name, not an id.** The person entering merchandise knows "Steve
Madden" and could not know a uuid, so the service resolves it against the
existing brands case-insensitively and creates it only if it is genuinely new.
The same holds for a classification value. Neither is a separate management
screen to visit first.

**New merchandise always begins `ACTIVE`**, so lifecycle is not a request field —
nor is any id, SKU, signature, or timestamp. `.strict()` refuses all of them.

Rejections use the central structured error format:

- `VALIDATION_FAILED` (400) — blank name, no variants, blank attribute name or
  value, duplicate variants in one request, a malformed price, a duplicate or
  whitespace-bearing barcode, an **unknown classification dimension**, an
  **attribute name that is not in the vocabulary**, or any unknown field
  (including a client-supplied `sku`, which the schema refuses). The last two
  name what is allowed in the error detail, so a caller is told what to use.
- `CONFLICT` (409) — a genuine uniqueness collision at the database.

### `GET /api/catalog/products` — list products

Returns `200 OK` with an array of every product: brand, classifications,
lifecycle, and for each variant its SKU, attributes, selling price, reference
cost, and barcodes. An empty catalog is an empty array.

Ordering is deterministic at every level — products and variants by creation
time then id, classifications by dimension key, attributes by normalized name,
barcodes by code. The whole catalog is read in **at most five statements**, and
`getProductById` is the same loader with a filter, so what creation returns and
what the list returns cannot differ. No pagination, filtering, search, or
sorting yet.

**Merchandise that predates the model reads back as honest absence**:
`brand: null`, `classifications: []`, `sellingPrice: null`, `referenceCost:
null`, `barcodes: []`. Nothing is invented — no brand is parsed out of a product
name, and no zero stands in for a price nobody has set.

### `GET /api/catalog/metadata` — the vocabulary

Returns `200 OK` with the brands, the classification dimensions and their
values, and the controlled attribute names, so a form can offer them rather than
have somebody type one and be refused.

One bounded read rather than an endpoint per vocabulary: three small lists,
always wanted together, by the one form that needs them. **Read-only** — brands
and classification values are created as a side effect of entering merchandise,
and attribute names grow by migration, so there is nothing here for a management
endpoint to manage.

### `PATCH /api/catalog/products/:productId/lifecycle` — withdraw or restore a product

### `PATCH /api/catalog/variants/:variantId/lifecycle` — the same, for one SKU

```jsonc
// request
{ "lifecycleStatus": "DISCONTINUED" }

// 200 OK — the product (or the variant) as it now stands
```

Requires **`catalog.deactivate`**, not `catalog.write`. The narrower capability
already existed for exactly this: deciding what the business stops selling is a
different authority from entering what it sells, and somebody trusted to type in
a new sandal is not thereby trusted to withdraw the range.

**Declarative, not imperative.** The body says what the merchandise should be,
so sending it twice changes nothing the second time and two people pressing the
same button agree. A `POST /discontinue` would be a verb per transition, with
the matrix spread across the URL space instead of stated once.

`.strict()` refuses everything else, `isActive` included — it is not a field
this system has any more. The id is in the path and refused in the body: two
statements of one identity can disagree, and the one that would win is the one
nobody reads. A malformed id is a `400` rather than an internal error about uuid
syntax, because the path is parsed with a shared schema like any other input.

There is no operation id and no `operations` row. Lifecycle is not a stock
movement — it moves no quantity and posts nothing to the ledger — and a
declarative state assignment is already idempotent.

Separate routes for a product and a variant rather than one endpoint taking
either, because they are separate decisions about separate things. Withdrawing
the product already governs every variant beneath it through the effective rule,
so nothing cascades and nothing needs to.

Refusals: `404` for merchandise that does not exist, `409` for a transition the
matrix does not permit and for an archive blocked by remaining stock, `403`
without the capability, `401` without a session.

## What other modules ask this one

The catalog owns every table listed at the top of this file, and no other module
may query them — the lint rule enforces the boundary. Five questions cross it,
all as calls on `CatalogService`, and none of them decides anything about stock:

- `findVariantForReceiving(tx, id)` — may stock be **booked in** against this?
- `findVariantForIssue(tx, id)` — may stock be **taken off the shelf**?
- `findVariantForCorrection(tx, id)` — may its recorded history be **corrected**
  (adjusted, or a movement reversed)?
- `findVariantForCounting(tx, id)` — may it be **physically counted**, and a
  variance reconciled?
- `listOperationalVariants()` — every variant still in day-to-day operation,
  with the product name, SKU, and attributes needed to label one. Asked by the
  inventory module to build the current stock view.

A fifth, `findVariantLabels(ids)`, answers a different kind of question
entirely: what merchandise is _called_, for reading history, **regardless of
lifecycle**. Evidence is not filtered by present-tense availability — a movement
against merchandise the shop has since archived is exactly the record somebody
goes looking for.

### Three questions, not one flag

`findStockableVariant` and its `isActive` are gone, and so is the boolean behind
them. One flag could say only "available", which was enough while one boolean
governed everything and is wrong now: **discontinued merchandise may be sold and
counted and corrected, but not replenished.** A single question would have
forced each workflow to interpret the answer, and receiving and removal would be
interpreting it separately — which is how two workflows quietly disagree about
what the shop sells.

So each workflow names what it is about to do, and each service's dependency is
narrowed to its own question (`Pick<CatalogService, 'findVariantForReceiving'>`).
Receiving cannot reach the issue rule even by accident: the type does not have
it.

All four answer from **effective lifecycle** — the stricter of the variant's own
status and its parent product's — and never from a raw column. The
eligibility calls return `{ id, productId, lifecycleStatus, permitted }`;
`null` still means only "no such variant", which callers turn into a `404` while
`permitted: false` becomes a `409`. Which of the two rows caused the refusal is
deliberately not reported, because no caller does anything different about it.

### They take a transaction, and they lock

The three singular questions take the caller's transaction client and read the
product and variant rows `FOR SHARE`. That is not a detail of the current call
site: it is what makes archive safety an invariant rather than a hope. A
lifecycle change takes `FOR UPDATE` on the same rows, so it and a movement
cannot cross unnoticed — see [Lifecycle](#lifecycle) below and INV-19.

Ordering for the list is fixed here — product name, SKU, then variant id — so
every consumer sees the same one.

## SKU format and immutability

- Format: `EKN-XXXXXXXX` — eight uppercase, non-semantic characters from an
  alphabet that omits the ambiguous `0 1 I O`.
- Non-semantic: derived from nothing (not name, attributes, date, or a
  sequence), so it never has to change. Random, from a CSPRNG.
- Unique and immutable: a `UNIQUE` constraint enforces uniqueness (with a small
  bounded server-side retry on the astronomically unlikely collision), and a
  `BEFORE UPDATE` trigger rejects any change to the column.
- The client can never choose or override a SKU.

## Variant-signature normalization

A variant's identity is its normalized attribute set, reduced to one
deterministic `variant_signature`. Identity is **case-insensitive** on both
names and values; the human-readable **display** value is kept separately.

1. Attribute **names** are trimmed and lower-cased (`"Color"`, `" color "`, and
   `"COLOR"` are the same attribute).
2. Attribute **values** are trimmed for display, with case **preserved** in
   what is stored and returned — `" White "` is stored and returned as `"White"`.
3. Attribute values are **case-insensitive for identity**: `"White"`, `"white"`,
   and `" WHITE "` are the same variant. `"White"` and `"white"` therefore
   cannot create two separate variants.
4. Attributes are sorted by normalized name.
5. The signature is the JSON of the sorted `[name, identityValue]` pairs — where
   `identityValue` is the trimmed, **lower-cased** value; JSON quoting keeps the
   name/value boundary unambiguous.

Lower-casing uses ordinary Unicode (locale-independent) case mapping
(`String.prototype.toLowerCase()`). The empty attribute set yields `[]` — the
signature of a default variant. A `UNIQUE (product_id, variant_signature)`
constraint makes the database, not just the application, reject a duplicate
variant. Clients must treat `variantSignature` as opaque — never construct or
parse it.

## Authorization

Both routes are **capability-protected**. Each declares what it requires in its
Fastify `config` — `catalog.write` to create, `catalog.read` to list — and the
identity module's enforcement hook resolves the session cookie and checks the
capability before the handler runs. A caller who reaches a handler here is
signed in and holds the capability.

Neither handler contains an authorization check, and neither knows anybody's
role: `role_capabilities` decides what a role may do, and business code asks
only what the caller may do. A request with no valid session is `401`; a signed-in
caller without the capability is `403`, and the handler is never entered — no
product is created and no `operations` row is written.

Neither route reads the actor, because creating a product records no `user_id`
yet. The workflows that do will take it from `requireActor(request)`, never from
the request body.

## In the browser

`POST /api/catalog/products` is reached from the products screen, by somebody
holding `catalog.write` — see
[frontend/README.md](../../../../frontend/README.md). Nothing about this module
changed to make that possible: the frontend builds its request with this
module's own `createProductRequestSchema`, which is `.strict()` and therefore
refuses a client-supplied `id`, `variantSignature`, or `sku` before the request
leaves the browser as well as after it arrives.

The route has **no operation id and writes no `operations` row**, and the
frontend sends none. That is the same decision account creation made: the header
exists so a retried _movement_ posts once, and claiming idempotency here would
mean a genuine second product was answered with the first one. There is no
uniqueness on a product name either, so an automatic retry would be an automatic
duplicate — which is why the browser never retries this on its own.

## The merchandise model

Migration 0009 put the model into the database and 0010 closed its last open
bridge; this module now reads and writes all of it.

Every existing product id, variant id, SKU, variant signature, attribute,
movement, and balance came through both migrations untouched. Nothing was
inferred from existing data: no brand was parsed out of a product name, no
category guessed, no price or cost invented. Those columns are `NULL` on
merchandise nobody has reviewed, and `NULL` means "not established yet" — a zero
would say the item is free.

| What                         | Where                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Brand, as structured data    | `brands`; `products.brand_id`, nullable                                           |
| Classification               | `classification_dimensions` → `classification_values` → `product_classifications` |
| Controlled attribute names   | `variant_attribute_definitions`                                                   |
| Selling price                | `product_variants.selling_price_minor` + `_currency`                              |
| Acquisition / reference cost | `product_variants.reference_cost_minor` + `_currency`                             |
| External identifiers         | `variant_barcodes`                                                                |
| Lifecycle                    | `products.lifecycle_status`, `product_variants.lifecycle_status`                  |

**Brands** hold one canonical `normalized_name` alongside the display `name`,
tied together by a CHECK, so `Steve Madden` and `steve madden` cannot become two
brands and the shop still sees the case it typed. A product may name no brand at
all, and existing ones do not.

**Classification is not variant variation.** `Audience: Kids` groups
merchandise; `Size: 8` produces a sellable identity. They live in different
tables for that reason, and the assignment table's composite key onto
`classification_values (id, dimension_id)` makes it impossible to file a product
under a value belonging to another dimension. One value per dimension per
product. The three dimensions ADR 11 names — audience, category, type — are
seeded; no values are, because those are the shop's merchandise data. Find a
dimension by `key`, never by a hard-coded id.

**Price and cost are per variant**, in `bigint` minor units with an explicit
currency, and each carries its own currency because merchandise bought in USD
and sold in HTG is the ordinary case here. `reference_cost_*` is a reference
figure and **not inventory valuation** — one mutable number that does not know
which units on the shelf came from which purchase. Nothing may read it and call
the result profit (INV-17).

**A barcode never replaces the SKU.** `EKN-XXXXXXXX` is Ekon's own, immutable,
and on the shelf label; a barcode is somebody else's identifier attached to a
variant, in a child table because one item can legitimately carry several.
Uniqueness is per variant, not global — deliberately, because manufacturer
codes are reused in the real world and a global constraint would refuse to
record the truth (INV-13).

### Lifecycle

```text
ACTIVE  ⇄  DISCONTINUED  ⇄  ARCHIVED
```

`lifecycle_status` on both `products` and `product_variants` is now the **only**
authority on merchandise availability. `is_active` was the bridge 0009 opened
deliberately and 0012 closed: both columns are dropped, and there is one notion
of withdrawn rather than two adjacent ones that get checked in different places.

#### What each status permits

| effective status | receive | issue | count | correct | current stock | history |
| ---------------- | ------- | ----- | ----- | ------- | ------------- | ------- |
| `ACTIVE`         | yes     | yes   | yes   | yes     | shown         | shown   |
| `DISCONTINUED`   | **no**  | yes   | yes   | yes     | **shown**     | shown   |
| `ARCHIVED`       | no      | no    | no    | no      | not shown     | shown   |

`DISCONTINUED` means **no longer bought or reordered, and nothing else**.
Receiving is refused because replenishing something the business decided to stop
stocking is the one act the decision was about; everything else stays open. The
units on the shelf are sold to real customers, physically counted (PR 6 made
that column real rather than a promise), and shown on the stock screen. A system that made discontinued merchandise invisible would
strand it — and stranded stock is sold anyway, off the books, which is worse
than not discontinuing it at all.

`ARCHIVED` means out of day-to-day operation, retained for history. It leaves
the current-stock view, which is honest only because **archiving is refused
while any stock remains**.

**A quantity reaching zero is not a lifecycle change.** Selling the last unit is
a fact about a shelf; discontinuing is a decision about merchandise. Nothing in
this system promotes one into the other, in either direction.

Corrections get their own column in that table for a reason: a correction
concerns ledger truth rather than replenishment, so `DISCONTINUED` must never
block one — discontinuing something on Friday cannot make Thursday's mis-keyed
receipt permanent. `ARCHIVED` does block one, because it would put units back on
a shelf the archive asserts is empty. The remedy is explicit rather than
implied: restore it to `DISCONTINUED`, correct the ledger, archive it again.

#### Effective status: a variant is never more available than its product

The effective status of a variant is the **stricter** of its own and its parent
product's. An `ACTIVE` variant of a `DISCONTINUED` product behaves as
discontinued; one of an `ARCHIVED` product behaves as archived. The reverse is
the ordinary case and is left alone: a `DISCONTINUED` variant under an `ACTIVE`
product is one colour the shop stopped buying, and its siblings are unaffected.

**Derived, not propagated.** Withdrawing a product does not rewrite its
variants' rows — because then restoring it could not know which of them the shop
had already discontinued on their own, and the mass update would have erased
exactly the information needed to undo itself. The rule is one function,
`effectiveLifecycle` in `domain/lifecycle.ts`, and every query and every
workflow goes through it rather than remembering how to combine two statuses.

#### The transition matrix

| from → to      | `ACTIVE`      | `DISCONTINUED` | `ARCHIVED`            |
| -------------- | ------------- | -------------- | --------------------- |
| `ACTIVE`       | no-op         | yes            | yes, if stock is zero |
| `DISCONTINUED` | yes, restores | no-op          | yes, if stock is zero |
| `ARCHIVED`     | **no**        | yes, restores  | no-op                 |

`ACTIVE → ARCHIVED` skips a step on purpose: merchandise entered by mistake,
with nothing to sell down, is archived directly rather than made to perform a
ritual.

**Restoration exists because people click the wrong row.** A one-way tombstone
would mean the remedy for a mis-click is a database session, and a system whose
only correction path is `psql` does not have a correction path. Both restoring
steps go back exactly one stage, and `ARCHIVED → ACTIVE` is refused for that
reason — coming back into day-to-day operation and being reordered again are two
decisions, so they are two clicks. A refusal is a `409` whose message names what
_is_ permitted.

Setting the status something already has is a **no-op**: a declarative `PATCH`
restating the current state has nothing to do and no reason to fail, and it does
not move `updated_at` either.

#### Archive safety

Archiving a variant requires its total on-hand quantity across every location to
be zero; archiving a product requires that of **every** variant beneath it, read
in one bulk query rather than one per SKU. A refusal names how much is where,
and the remedy is real: issue or adjust the remaining units, then archive.
**Nothing writes stock off to get an archive through**, and the lifecycle
workflow never posts a movement on anybody's behalf.

Stock belongs to the inventory module, so the catalog does not query
`inventory_balances`. It declares the one question it has —
`StockPresenceReader.findVariantsHoldingStock(tx, variantIds)` — and the
composition root hands it the inventory module's implementation. The mirror
image of how inventory asks this module whether a variant may be stocked, and
the reason neither ends up reaching across the boundary.

**The check is not check-then-act.** Both sides take PostgreSQL row locks in one
fixed order — `products`, then `product_variants`, then the balances:

- a lifecycle change locks the merchandise rows `FOR UPDATE` and only **then**
  reads the balances;
- every posting workflow locks the same rows `FOR SHARE` inside its posting
  transaction, before it touches a balance.

So an archive and a receipt cannot both succeed: whichever reaches the
merchandise row first commits, and the other sees it and is refused. They
contend on the **catalog** row rather than the balance row, which matters
because a shelf that has never held stock has no balance row to contend for.
`READ COMMITTED`, no retry loop, no advisory lock, and no in-memory mutex —
which would protect one process, and this system will not always be one process.
`backend/tests/integration/catalogLifecycleConcurrency.test.ts` stages both
directions of the race behind a barrier that asks PostgreSQL itself whether the
commands are genuinely blocked. See INV-19.

#### What is not recorded

**A lifecycle change records no actor and no history.** The status and
`updated_at` persist and `catalog.deactivate` is enforced, but nothing says who
withdrew a product or when it was last restored. That belongs in `audit_events`,
and the audit module does not exist — building a general audit subsystem for this
one workflow would be a larger project than the workflow. The limitation is
stated rather than worked around, and a lifecycle change is meanwhile
attributable only through the application log.

**A lifecycle change is not an inventory movement**, and no fake movement is
posted for one. It moves no quantity, and a `RECEIPT` of zero to record a
policy decision would corrupt the one table the whole system rests on.

### Controlled attribute names

An attribute name must be in `variant_attribute_definitions`. The vocabulary
0010 seeds is `color`, `size`, `width`, `material` — enough for the merchandise
in ADR 11: footwear varies by colour, size and width, handbags by colour and
material, socks by colour and size.

**An unknown name is refused, not defined.** This is the opposite of how a brand
or a classification value is handled, and the asymmetry is the rule: an
attribute name is _structure_. `color` is the shape variant identity takes
across the whole catalog and it is baked into `variant_signature` permanently, so
a shop that can create one by typing it ends up with `color`, `colour`, and
`couleur` describing the same thing and no report by colour is possible again. A
brand or a category is data about one product and costs nothing to add.

Growing the vocabulary is therefore a **migration** until there is a workflow for
it. That is a real limitation and it is stated rather than worked around: PR 7's
form offers the defined names from `GET /api/catalog/metadata`, and merchandise
that needs a fifth attribute needs a migration first.

**Attribute _values_ stay free display text.** `Black` is not a controlled
option, and this PR did not build an option-management engine for one.

#### What the database guarantees, and what it does not

`variant_attributes_name_defined_fk` (0010) is a `NOT VALID` foreign key onto
`variant_attribute_definitions (name)`. PostgreSQL enforces it on **every insert
and update**, and does not check rows that were already there.

Both halves are deliberate. New writes are controlled by the database rather than
only by the service check above, which somebody could forget to call. And every
attribute stored before any vocabulary existed — a Creole name typed into a
Creole-speaking shop — keeps its name, its value, and its place in its variant's
signature. A migration that refused to apply over such a row would block the
deploy; one that renamed it would change which variant the row identifies and
orphan the inventory history keyed to it.

Full enforcement becomes possible once every distinct name in
`variant_attributes` has a definition — an operator task of reading them,
deciding which are real merchandise attributes and which were mistakes, and
defining the real ones. It completes with

```sql
ALTER TABLE variant_attributes VALIDATE CONSTRAINT variant_attributes_name_defined_fk;
```

which leaves an ordinary fully-valid key. A fresh installation has nothing to
review and would pass that statement today; it is not run in a migration because
a migration cannot know which installation it is on. See INV-18.

## Not yet

Product and variant updates of any kind beyond lifecycle — renaming, re-pricing,
re-classifying, editing or removing a barcode after creation. Deletion.
Pagination, filtering, search. Brand or vocabulary administration. Controlled
attribute _values_. Barcode scanning. Costing beyond the single reference
figure. Anything to do with inventory movements or balances beyond the one
stock-presence question archive safety asks.

**Audit.** A lifecycle change records no actor and no history — see
[What is not recorded](#what-is-not-recorded). The audit module has a README and
no code.

**Screens.** There is no lifecycle control in the interface: PR 5 is backend and
contracts, and PR 7 builds the operational UI. The receiving screen filters its
choices to `ACTIVE` merchandise, which is the only frontend change lifecycle
required.

Product creation still carries **no operation id and writes no `operations`
row**, and the frontend still sends none. Nothing about that changed because the
command got richer: the header exists so a retried _movement_ posts once, and
claiming idempotency here would mean a genuine second product being answered
with the first one. There is no uniqueness on a product name either, so an
automatic retry would be an automatic duplicate — which is why the browser never
retries this on its own.

The product screen is still the temporary shell: it captures a name, a
description, and free-typed attribute names, so an attribute outside the
vocabulary is refused by the server rather than absent from a picker. The
merchandise form that captures brand, classification, price, cost, and barcodes
is **PR 7**.
