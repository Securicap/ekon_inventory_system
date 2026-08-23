# `catalog` module

**Owns:** `products`, `product_variants`, `variant_attributes`, `brands`,
`classification_dimensions`, `classification_values`, `product_classifications`,
`variant_attribute_definitions`, `variant_barcodes`

**Responsibility:** what can be stocked, and the SKU that identifies it.

> **The schema is ahead of the code.** Migration 0009 added the merchandise
> foundation — brands, classification, controlled attribute definitions,
> SKU-level price and reference cost, barcodes, and lifecycle — and **no
> endpoint, service, or repository function reads or writes any of it yet.**
> Everything described under [Endpoints](#endpoints) below is the whole of what
> this module currently does. See
> [The merchandise foundation](#the-merchandise-foundation-schema-only) for
> what is now in the database and what PR 3 will do with it.

Inventory is stored per **variant**, never per product. Every product therefore
has at least one variant; a plain item is a single default variant with no
attributes. `variant_signature` (the normalized, sorted attribute set) carries a
uniqueness constraint per product so "White / Size 9" cannot be created twice.

SKUs are generated server-side, unique, and immutable — they end up on physical
shelf labels.

`variant_attributes` is a thin key/value table. It was written without an
attribute-definition table on the reasoning that a generic attribute engine is
the classic overengineering trap in inventory systems, and that a controlled
vocabulary could be added and backfilled from distinct existing values if it
were ever needed. The merchandise model now needs one, and 0009 added it on
exactly those terms — `variant_attribute_definitions`, a table of names and
nothing else. **It is not yet connected to this table**; see
[Controlled attribute names](#controlled-attribute-names).

## Endpoints

### `POST /api/catalog/products` — create a product

Creates a product and all of its variants and attributes in a single
transaction. Returns `201 Created` with the complete product, including the
server-generated variant SKUs. A failure at any point leaves no partial records.

```jsonc
// request
{
  "name": "Running Shoe",
  "description": "Optional",
  "variants": [{ "attributes": { "color": "White", "size": "9" } }],
}
```

Rejections use the central structured error format:

- `VALIDATION_FAILED` (400) — blank name, no variants, blank attribute name or
  value, duplicate variants in one request, or any unknown field (including a
  client-supplied `sku`, which the schema refuses).
- `CONFLICT` (409) — a genuine uniqueness collision at the database.

### `GET /api/catalog/products` — list products

Returns `200 OK` with an array of every product, each with its variants and
their attributes. An empty catalog is an empty array. Ordering is deterministic
(products and variants by creation time then id; attributes by normalized name).
The whole catalog is read in a fixed number of queries — no N+1. No pagination,
filtering, search, or sorting yet.

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

## The merchandise foundation (schema only)

Migration 0009 put Ekon's approved merchandise model into the database:
`Classification → Product → Variant/SKU → SKU × Location`
([the domain document](../../../../docs/03-architecture/retail-domain-and-or1.md),
ADR 11). Nothing in this module reads it. It is here so that PR 3 changes a
write path rather than a write path and a schema at the same time.

Every existing product id, variant id, SKU, variant signature, attribute,
movement, and balance came through 0009 untouched. Nothing was inferred from
existing data: no brand was parsed out of a product name, no category guessed,
no price or cost invented. Those columns are `NULL` on existing merchandise,
and `NULL` means "not established yet" — a zero would say the item is free.

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

### Lifecycle, and the flag it does not yet replace

`ACTIVE → DISCONTINUED → ARCHIVED`, on both products and variants, defaulting to
`ACTIVE`. A quantity reaching zero is **not** a lifecycle change: selling the
last unit is a fact about a shelf, discontinuing is a decision about
merchandise.

**`is_active` is still the only flag anything reads.** `findStockableVariant`
and `listStockableVariants` are unchanged, so stockability behaves exactly as it
did before 0009 and `lifecycle_status` is inert — written by its default, read
by nobody. Two columns for adjacent notions is a bridge and not a design: making
lifecycle authoritative in the migration that introduced it would have changed
stockability underneath a deployed application with no way to set it. PR 5
builds the lifecycle workflow and resolves the two into one.

### Controlled attribute names

`variant_attribute_definitions` starts **empty**, and `variant_attributes` has
no foreign key onto it. That is deliberate, and it is the one place where the
schema could not finish the job on its own.

Adding the key would need a definition row for every distinct attribute name
already stored, each with a UUIDv7 — and ids here are generated in application
code, never by the database (0001), so that the offline milestone can move
generation to the browser without a schema change. A migration calling
`gen_random_uuid()` to satisfy a foreign key would trade that for a day's
convenience. It would also stop the deployed backend from creating a product
with an attribute name nobody had defined yet.

So: the vocabulary is populated by PR 3, from the distinct names already in
`variant_attributes`, with application-generated ids, and the constraint lands
once the write path can create a definition. Until then this endpoint still
accepts any attribute name, exactly as it always has.

## Not yet

Everything 0009 added is schema only — no endpoint reads or writes a brand, a
classification, an attribute definition, a price, a cost, a barcode, or a
lifecycle status, and no request or response schema mentions one. That is PR 3.

Also still absent: deactivation (products/variants carry `is_active` but nothing
sets it to false yet — both questions above already honour both flags, so the
workflow that lands it only has to set the column), product/variant updates,
deletion, pagination/filtering/search, and anything to do with inventory
movements, balances, or the audit log.
