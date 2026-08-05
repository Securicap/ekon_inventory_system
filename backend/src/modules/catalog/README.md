# `catalog` module

**Owns:** `products`, `product_variants`, `variant_attributes`

**Responsibility:** what can be stocked, and the SKU that identifies it.

Inventory is stored per **variant**, never per product. Every product therefore
has at least one variant; a plain item is a single default variant with no
attributes. `variant_signature` (the normalized, sorted attribute set) carries a
uniqueness constraint per product so "White / Size 9" cannot be created twice.

SKUs are generated server-side, unique, and immutable — they end up on physical
shelf labels.

`variant_attributes` is a thin key/value table, deliberately not a generic
attribute-definition engine. That engine is the classic overengineering trap in
inventory systems; if controlled vocabularies are ever needed they can be added
and backfilled from distinct existing values.

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

The catalog owns `products`, `product_variants`, and `variant_attributes`, and
no other module may query them — the lint rule enforces it. Two questions cross
that boundary today, both as calls on `CatalogService`, and neither of them
decides anything about stock:

- `findStockableVariant(id)` — does this variant exist, and may it still be
  stocked? Asked by receiving before it posts. One row, three columns.
- `listStockableVariants()` — every variant that may currently be stocked, with
  the product name, SKU, and attributes needed to label one. Asked by the
  inventory module to build the current stock view, which composes it with its
  own locations and balances.

Both are filtered to the **active**, and `listStockableVariants` gates a variant
on its parent product's `is_active` as well as its own: an active variant under a
withdrawn product is not something the business sells. Neither returns
`is_active` itself, because there is nothing left for the caller to decide.
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

## Not yet

Deactivation (products/variants carry `is_active` but nothing sets it to false
yet — the reads above already honour it, so the workflow that lands it changes
nothing here), product/variant updates, deletion, pagination/filtering/search,
controlled vocabularies or attribute-definition tables, barcodes/labels, and
anything to do with inventory movements, balances, or the audit log.
