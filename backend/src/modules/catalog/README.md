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

## Authorization (temporary gap)

Capability enforcement is **not wired yet**: no authenticated principal exists
because the identity module is still a scaffold. Each route declares the
capability it will require in its Fastify `config` (`catalog.write` for create,
`catalog.read` for list), so a single `onRequest` hook can enforce them once
identity lands, without changing these handlers. **Until then these endpoints are
unauthenticated.** This is intentional and isolated to this gap; no temporary
authentication was invented.

## Not in this PR

Deactivation (products/variants carry `is_active` but nothing sets it to false
yet), product/variant updates, deletion, pagination/filtering/search, controlled
vocabularies or attribute-definition tables, barcodes/labels, and anything to do
with inventory movements, balances, or the audit log.
