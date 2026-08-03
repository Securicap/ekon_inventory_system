# `catalog` module

**Owns:** `products`, `product_variants`, `variant_attributes`

**Responsibility:** what can be stocked, and the SKU that identifies it.

Inventory is stored per **variant**, never per product. `variant_signature` (the
normalized, sorted attribute set) carries a uniqueness constraint per product so
"White / Size 9" cannot be created twice.

SKUs are generated server-side, unique, and immutable — they end up on physical
shelf labels.

`variant_attributes` is a thin key/value table, deliberately not a generic
attribute-definition engine. That engine is the classic overengineering trap in
inventory systems; if controlled vocabularies are ever needed they can be added
and backfilled from distinct existing values.

Arrives in the catalog PR.
