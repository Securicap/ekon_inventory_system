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

## What other modules ask this one

The catalog owns every table listed at the top of this file, and no other module
may query them — the lint rule enforces the boundary. Two questions cross it
today, both as calls on `CatalogService`, and neither of them decides anything
about stock:

- `findStockableVariant(id)` — does this variant exist, and may it still be
  stocked? Asked by receiving and by removal before either posts. One row, three
  columns.
- `listStockableVariants()` — every variant that may currently be stocked, with
  the product name, SKU, and attributes needed to label one. Asked by the
  inventory module to build the current stock view, which composes it with its
  own locations and balances.

Both apply the **same** stockability rule, and it is the catalog's rule rather
than each caller's:

> A variant is stockable only when the variant **and its parent product** are
> both active.

`listStockableVariants` applies it as a filter — an active variant under a
withdrawn product is not something the business sells, so it is not listed, and
it returns no `is_active` at all. `findStockableVariant` cannot filter, because
"unstockable" and "no such variant" are different answers and its callers turn
them into different statuses; it returns the rule's result instead. **Its
`isActive` is therefore effective stockability, not the
`product_variants.is_active` column** — false for a retired variant and equally
false for a live variant under a retired product. Callers are not told which,
because no caller does anything different about it.

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

### Lifecycle is read, and nothing sets it

`ACTIVE → DISCONTINUED → ARCHIVED`, on both products and variants. New
merchandise is written `ACTIVE`, `lifecycleStatus` is on the wire, and **there is
no endpoint that changes it.** A quantity reaching zero is **not** a lifecycle
change: selling the last unit is a fact about a shelf, discontinuing is a
decision about merchandise.

**`is_active` is still the only flag that decides stockability.**
`findStockableVariant` and `listStockableVariants` are unchanged, so receiving
and removal behave exactly as they did before 0009, and archiving a product
changes nothing about what may be stocked — a test asserts it. Two columns for
adjacent notions is a bridge and not a design, and it is why both are on the
wire: `isActive` is stockability today, `lifecycleStatus` is merchandise policy.
Making lifecycle authoritative before anything can set it would change what may
be received underneath merchandise nobody has reviewed. **PR 5** builds the
lifecycle workflow and resolves the two into one.

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

**Lifecycle mutation.** Nothing discontinues or archives anything — PR 5.

Deactivation (products and variants carry `is_active` but nothing sets it to
false yet — both questions above already honour both flags, so the workflow that
lands it only has to set the column), product and variant updates of any kind,
deletion, editing or removing a barcode after creation, pagination, filtering,
search, brand or vocabulary administration, controlled attribute _values_,
barcode scanning, costing beyond the single reference figure, and anything to do
with inventory movements, balances, or the audit log.

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
