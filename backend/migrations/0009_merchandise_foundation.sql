-- 0009_merchandise_foundation.sql
--
-- The schema foundation for Ekon's approved retail merchandise model
-- (docs/03-architecture/retail-domain-and-or1.md, ADR 11):
--
--     Classification -> Product -> Variant / SKU -> SKU x Location Inventory
--
-- Strictly additive. Nothing here rewrites a row, re-keys an identity, or
-- narrows an existing constraint. Every existing product id, variant id, SKU,
-- variant signature, attribute, movement, and balance is untouched, because a
-- merchandise model that got richer is not a reason to renumber anything the
-- ledger already points at.
--
-- What this migration adds:
--
--   * `brands`                          — brand as structured data, not text
--                                         typed into a product name.
--   * `classification_dimensions`       — the controlled vocabulary describing
--     `classification_values`             how merchandise is grouped, and the
--     `product_classifications`           assignment of one value per dimension
--                                         to a product.
--   * `variant_attribute_definitions`   — the controlled vocabulary of variant
--                                         attribute names.
--   * selling price and reference cost on `product_variants`.
--   * `variant_barcodes`                — external identifiers attached to a
--                                         SKU, which they never replace.
--   * `lifecycle_status` on `products` and `product_variants`.
--
-- What this migration deliberately does NOT do:
--
--   * It does not guess. No brand is parsed out of a product name, no category
--     is inferred, and no price, cost, or barcode is invented. Every one of
--     those columns starts NULL on existing merchandise and is completed by a
--     person who knows the stock. NULL means "not established yet"; zero would
--     mean "free", and the two are not the same fact.
--   * It does not change what the application does. Every column added to an
--     existing table is either nullable or has a DEFAULT, so the catalog
--     writes in `catalogRepository.ts` — which name none of them — keep
--     working exactly as they do today. The merchandise API is PR 3.
--   * It does not link `variant_attributes` to the new definitions. That link
--     needs a definition row per existing attribute name, and ids in this
--     system are UUIDv7 generated in application code (0001), never by the
--     database. Manufacturing them in SQL to satisfy a foreign key would break
--     the one convention the offline milestone depends on. The vocabulary is
--     populated, and the link enforced, by PR 3 — see the transition note on
--     `variant_attribute_definitions` below.
--   * It does not touch stockability. `is_active` remains the only flag any
--     query reads; `lifecycle_status` is inert until PR 5.
--
-- Conventions from 0001 apply throughout: uuid primary keys generated in
-- application code (no database defaults), timestamptz with
-- application-supplied values rather than now(), money as bigint in minor units
-- with an explicit currency, text + CHECK instead of native enums, and
-- ON DELETE RESTRICT onto rows that carry history.

BEGIN;

-- Brands -------------------------------------------------------------------
--
-- "Steve Madden" is a fact about a product, not eleven characters at the front
-- of its name. A shop that writes the brand into the name cannot answer what a
-- brand does for it, cannot correct a spelling once, and gets a new brand every
-- time somebody types one differently.
--
-- Identity is case-insensitive; display case is not. `Steve Madden`,
-- `steve madden`, and `STEVE MADDEN` are one brand, and the one the shop sees
-- is whichever it entered. That is the same split the catalog already makes
-- between an attribute's display value and its identity value (0003), and it is
-- made the same way: one canonical column, one display column, and a CHECK
-- tying them together so the pair cannot drift apart. `citext` is deliberately
-- not used, for the reason 0007 gives — a case-insensitive comparison would
-- leave two different-looking strings in one column with no stated canonical
-- form.

CREATE TABLE brands (
  id              uuid        PRIMARY KEY,
  name            text        NOT NULL,
  normalized_name text        NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,

  -- One brand per normalized name. The unique index this creates is also the
  -- lookup index a "does this brand already exist?" check will use.
  CONSTRAINT brands_normalized_name_unique UNIQUE (normalized_name),

  -- The display form: trimmed, case preserved, bounded.
  CONSTRAINT brands_name_trimmed   CHECK (name = btrim(name)),
  CONSTRAINT brands_name_not_blank CHECK (length(name) > 0),
  CONSTRAINT brands_name_max_len   CHECK (length(name) <= 120),

  -- The identity form is derived from the display form and nothing else, so a
  -- caller cannot store a normalized name that belongs to a different brand.
  -- With `name` already trimmed, this also makes `normalized_name` trimmed and
  -- lower-cased without a second constraint to disagree with.
  CONSTRAINT brands_normalized_name_derived CHECK (normalized_name = lower(name))
);

-- A product may name its brand. Nullable on purpose and for as long as it takes:
-- existing products carry no structured brand, and there is no honest way to
-- recover one from a name that may or may not contain it. Whether a product
-- must eventually have a brand is a merchandise-review question, not a
-- migration question.
ALTER TABLE products
  ADD COLUMN brand_id uuid REFERENCES brands (id) ON DELETE RESTRICT;

-- Postgres does not index a foreign-key column automatically, and "what do we
-- sell of this brand" is the question this column exists to answer.
CREATE INDEX products_brand_id_idx ON products (brand_id);

-- Classification -----------------------------------------------------------
--
-- Classification describes how merchandise is grouped. It is not variant
-- variation, and the two must not share a table: `Sandals` produces no sellable
-- identity, `Size 8` does. Putting `category` into `variant_attributes` would
-- leave nothing able to tell a grouping from a variation.
--
-- Three tables, and deliberately not more:
--
--   dimensions  the kinds of grouping that exist   (audience, category, type)
--   values      the permitted values of each one   (Kids, Footwear, Sandals)
--   assignments one value per dimension, per product
--
-- Dimensions are rows rather than columns because the shop will not stop at
-- three, and a fourth must not be a migration. This is not a taxonomy engine:
-- there is no hierarchy, no inheritance, no rule table, and no per-dimension
-- schema. If merchandise ever needs a tree of categories, that is a decision
-- with its own reasoning, taken then.

CREATE TABLE classification_dimensions (
  id         uuid        PRIMARY KEY,
  key        text        NOT NULL,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,

  -- The stable machine handle. Application code finds a dimension by key, never
  -- by a hard-coded id — the same rule 0004 states for the default location.
  CONSTRAINT classification_dimensions_key_unique UNIQUE (key),

  -- One canonical form, in one constraint: lowercase letters, digits and
  -- underscores, starting with a letter. A key is not display text, so unlike a
  -- brand it has no second, prettier form to keep in step.
  CONSTRAINT classification_dimensions_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),

  -- The display form, trimmed and bounded. What the interface actually renders
  -- comes from the locale files; this is what the shop typed.
  CONSTRAINT classification_dimensions_name_trimmed   CHECK (name = btrim(name)),
  CONSTRAINT classification_dimensions_name_not_blank CHECK (length(name) > 0),
  CONSTRAINT classification_dimensions_name_max_len   CHECK (length(name) <= 60)
);

CREATE TABLE classification_values (
  id               uuid        PRIMARY KEY,
  dimension_id     uuid        NOT NULL REFERENCES classification_dimensions (id) ON DELETE RESTRICT,
  value            text        NOT NULL,
  normalized_value text        NOT NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,

  -- A value belongs to exactly one dimension, and no dimension holds the same
  -- value twice under two spellings. `Footwear` under `category` and `Footwear`
  -- under `type` are two different values, which is why the dimension is part
  -- of the key. The index is also the dimension's own listing index.
  CONSTRAINT classification_values_unique_in_dimension UNIQUE (dimension_id, normalized_value),

  -- Lets an assignment prove, with a composite foreign key, that the value it
  -- names really belongs to the dimension it claims.
  CONSTRAINT classification_values_id_dimension_unique UNIQUE (id, dimension_id),

  CONSTRAINT classification_values_value_trimmed   CHECK (value = btrim(value)),
  CONSTRAINT classification_values_value_not_blank CHECK (length(value) > 0),
  CONSTRAINT classification_values_value_max_len   CHECK (length(value) <= 80),

  -- Identity is case-insensitive, display case is preserved, and the two are
  -- tied together exactly as they are for a brand.
  CONSTRAINT classification_values_normalized_derived CHECK (normalized_value = lower(value))
);

CREATE TABLE product_classifications (
  product_id   uuid        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  dimension_id uuid        NOT NULL,
  value_id     uuid        NOT NULL,
  created_at   timestamptz NOT NULL,

  -- One value per dimension per product. A product is Footwear or it is
  -- Handbags; it is not both under one `category`. The key also indexes the
  -- lookup that reads a product's classification.
  PRIMARY KEY (product_id, dimension_id),

  -- The dimension stored here must be the value's own dimension. Storing both
  -- and pointing a composite key at `classification_values (id, dimension_id)`
  -- is the same technique the ledger uses to keep a movement on its own chain
  -- (0005): the denormalized column exists to be constrained, not to be trusted.
  --
  -- `dimension_id` therefore needs no separate foreign key of its own — every
  -- value already references its dimension with ON DELETE RESTRICT, so a
  -- dimension in use here cannot be deleted either.
  CONSTRAINT product_classifications_value_in_dimension_fk
    FOREIGN KEY (value_id, dimension_id)
    REFERENCES classification_values (id, dimension_id)
    ON DELETE RESTRICT
);

-- "Everything classified as Footwear", and the index the composite foreign key
-- checks against.
CREATE INDEX product_classifications_value_idx
  ON product_classifications (value_id, dimension_id);

-- The three dimensions ADR 11 names, and no values -------------------------
--
-- Dimensions are structure: the architecture states that merchandise is grouped
-- by audience, category and type, so a fresh installation has them without
-- anybody creating them, exactly as 0004 seeds the one default location. Ids
-- and timestamps are literal rather than generated, because a migration must
-- produce the same rows in every environment and on every replay.
--
-- No *values* are seeded. `Kids`, `Footwear` and `Sandals` are this shop's
-- merchandise data, not this system's structure, and a migration that guessed
-- at them would be putting words in the owner's mouth.

INSERT INTO classification_dimensions (id, key, name, created_at, updated_at) VALUES
  ('01a02bea-c000-7a01-8a01-4b2f6d1c0a01', 'audience', 'Audience', '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z'),
  ('01a02bea-c000-7a02-8a02-4b2f6d1c0a02', 'category', 'Category', '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z'),
  ('01a02bea-c000-7a03-8a03-4b2f6d1c0a03', 'type',     'Type',     '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z');

-- Controlled variant attribute names ---------------------------------------
--
-- `variant_attributes` accepts any name a caller sends (0002, deliberately: the
-- generic attribute engine is the classic over-engineering trap, and the note
-- there says controlled vocabularies can be added and backfilled). The
-- merchandise model now asks for them, so that `colour`, `Color` and `couleur`
-- cannot become three attributes and a report by colour is possible at all.
--
-- The names here are stored in exactly the form `variant_attributes.
-- attribute_name` already uses — trimmed and lower-cased (0002) — so a
-- definition and an attribute are comparable without a translation step.
-- Unlike a brand there is no display form to preserve, because that column
-- never had one.
--
-- TRANSITION, and it is deliberate: this table starts EMPTY, and nothing
-- references it yet. Two things follow.
--
--   Existing attributes are untouched and keep working. The current backend
--   still inserts arbitrary names, and every attribute already stored keeps its
--   name, its value, and its place in its variant's signature.
--
--   The foreign key from `variant_attributes.attribute_name` onto this table is
--   NOT added here. Adding it would require a definition row for every distinct
--   name already stored, each with a UUIDv7 — and ids in this system are
--   generated in application code, never by the database (0001), because the
--   offline milestone depends on being able to move that generation to the
--   browser. A migration that called `gen_random_uuid()` to satisfy a foreign
--   key would trade that convention for a day's convenience. It would also,
--   the moment it landed, stop the deployed backend from creating a product
--   with an attribute name nobody had defined yet.
--
--   PR 3 populates the vocabulary from the distinct names already in
--   `variant_attributes`, with application-generated ids, and adds the
--   constraint once the write path can create a definition. Until then this
--   table is a place for definitions to live, and the uniqueness rule that
--   stops the same one being defined twice.

CREATE TABLE variant_attribute_definitions (
  id         uuid        PRIMARY KEY,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,

  -- One definition per attribute name. This is the constraint that makes the
  -- vocabulary controlled rather than a list.
  CONSTRAINT variant_attribute_definitions_name_unique UNIQUE (name),

  -- Identical in form and bound to `variant_attributes.attribute_name` (0002),
  -- so the foreign key PR 3 adds cannot fail on a shape mismatch.
  CONSTRAINT variant_attribute_definitions_name_normalized CHECK (name = lower(btrim(name))),
  CONSTRAINT variant_attribute_definitions_name_not_blank  CHECK (length(name) > 0),
  CONSTRAINT variant_attribute_definitions_name_max_len    CHECK (length(name) <= 60)
);

-- Selling price and reference cost -----------------------------------------
--
-- Both belong to the variant, because the variant is what is sold and what is
-- bought. Black/8 and Black/9 may be priced differently, and a product-level
-- default that variants inherit is a convenience PR 3 can add above these
-- columns without changing where the authoritative number lives.
--
-- Amounts follow 0001: `bigint`, in minor units (centimes), with an explicit
-- currency. Never a float, and never a bare number whose currency is assumed.
--
-- Price and cost carry SEPARATE currencies on purpose. This shop buys and sells
-- in a country where those are routinely not the same: merchandise acquired in
-- USD and sold in HTG is the ordinary case, not the exception. One shared
-- currency column would force one of the two numbers to be converted before
-- storage, at a rate nobody recorded, which is how a reference cost quietly
-- becomes fiction.
--
-- NULL is the answer for every existing variant, and it is a real answer:
-- "nobody has established this yet". A zero would say the item is free, or cost
-- nothing to acquire, and a margin computed from it would be a lie with a
-- number attached.
--
-- `reference_cost_minor` IS NOT INVENTORY VALUATION. It is one mutable number
-- per variant, overwritten the next time the shop buys the same item at a
-- different price. It does not know which units on the shelf came from which
-- purchase, so it cannot say what the stock is worth, and any margin derived
-- from it is an estimate against today's figure rather than a historical fact.
-- FIFO, weighted average, receipt-layer costing and valuation as of a date all
-- require cost to be carried on receipts and consumed by depletions — a ledger
-- concern, and post-OR1 work. Nothing in this system should ever read this
-- column and call the result profit.

ALTER TABLE product_variants
  ADD COLUMN selling_price_minor     bigint,
  ADD COLUMN selling_price_currency  text,
  ADD COLUMN reference_cost_minor    bigint,
  ADD COLUMN reference_cost_currency text;

ALTER TABLE product_variants
  -- An amount is never negative. A price of minus five is not a discount.
  ADD CONSTRAINT product_variants_selling_price_non_negative CHECK (
    selling_price_minor IS NULL OR selling_price_minor >= 0
  ),
  ADD CONSTRAINT product_variants_reference_cost_non_negative CHECK (
    reference_cost_minor IS NULL OR reference_cost_minor >= 0
  ),

  -- An amount is a pair. A number without a currency cannot be compared,
  -- displayed, or added to anything; a currency without a number is noise. The
  -- same shape as `operations_result_pointer_complete` (0005).
  ADD CONSTRAINT product_variants_selling_price_complete CHECK (
    (selling_price_minor IS NULL) = (selling_price_currency IS NULL)
  ),
  ADD CONSTRAINT product_variants_reference_cost_complete CHECK (
    (reference_cost_minor IS NULL) = (reference_cost_currency IS NULL)
  ),

  -- An uppercase three-letter code, in the ISO 4217 shape. Deliberately a
  -- pattern and not a list: which currencies the business accepts is an
  -- operational question that must not require a schema migration to answer,
  -- and a list committed here would be one more place to forget when it
  -- changes. The shape is what stops `usd`, `US$`, `dollars`, and ` HTG `.
  ADD CONSTRAINT product_variants_selling_price_currency_format CHECK (
    selling_price_currency IS NULL OR selling_price_currency ~ '^[A-Z]{3}$'
  ),
  ADD CONSTRAINT product_variants_reference_cost_currency_format CHECK (
    reference_cost_currency IS NULL OR reference_cost_currency ~ '^[A-Z]{3}$'
  );

-- Barcodes -----------------------------------------------------------------
--
-- A barcode does not replace the SKU and cannot. `EKN-XXXXXXXX` is Ekon's own,
-- assigned by the server, chosen by nobody, unique, immutable (INV-13), and
-- printed on the shelf label. A barcode is somebody else's identifier, attached
-- to a SKU: it may be absent, it may be reused across unrelated goods, it may
-- change between production runs, and one physical item may carry several.
--
-- A child table rather than a column, for the last of those reasons. Merchandise
-- that arrives with a manufacturer code and later gets a distributor's own label
-- has two, and both are true; a single column would force somebody to throw one
-- away, and the discarded one is the one on the box in the stockroom.
--
-- UNIQUENESS IS PER VARIANT, NOT GLOBAL, and that is a deliberate refusal. The
-- domain says these identifiers are external and carry none of the SKU's
-- guarantees. A global unique index would assert something the world does not
-- honour, and the first time two genuinely different items shipped with the same
-- code the database would refuse to record the truth. What is enforced is the
-- part that is actually guaranteed: one variant does not list the same code
-- twice. How a scan that matches two variants is resolved is a question for the
-- workflow that scans, which is post-OR1 — there is no scanning, no generation,
-- no check-digit validation, and no external catalogue lookup here.

CREATE TABLE variant_barcodes (
  id         uuid        PRIMARY KEY,
  variant_id uuid        NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  barcode    text        NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,

  -- One variant, one entry per code. Also the index for listing a variant's
  -- identifiers.
  CONSTRAINT variant_barcodes_variant_barcode_unique UNIQUE (variant_id, barcode),

  -- Structural checks only. The database does not attempt to know which symbology
  -- a string belongs to: EAN-13, UPC-A, Code 128 and an in-house label printed by
  -- a supplier have different alphabets and different lengths, and a schema that
  -- picked one would reject merchandise that exists.
  --
  -- No whitespace anywhere, which subsumes the trimmed check every other text
  -- column here carries and goes further: a tab or a newline in the middle of a
  -- scanned code is a data-entry accident, not an identifier. There is
  -- deliberately no second `= btrim(barcode)` constraint to say a weaker version
  -- of the same thing.
  CONSTRAINT variant_barcodes_not_blank CHECK (length(barcode) > 0),
  CONSTRAINT variant_barcodes_max_len   CHECK (length(barcode) <= 64),
  CONSTRAINT variant_barcodes_no_space  CHECK (barcode !~ '[[:space:]]')
);

-- The lookup a future scan makes: code in, variant out. Not unique, for the
-- reason above.
CREATE INDEX variant_barcodes_barcode_idx ON variant_barcodes (barcode);

-- Lifecycle ----------------------------------------------------------------
--
--     ACTIVE  ->  DISCONTINUED  ->  ARCHIVED
--
--   ACTIVE        sold and stocked normally.
--   DISCONTINUED  no longer bought or reordered. Existing stock is still sold
--                 and still counted — this is a decision about replenishment,
--                 not a decision to stop trading what is on the shelf.
--   ARCHIVED      out of day-to-day operation, retained for history.
--
-- A quantity reaching zero is NOT a lifecycle change. Selling the last unit is
-- a fact about a shelf; discontinuing is a decision about merchandise. A system
-- that conflates them either hides live products that happen to be out of stock
-- or keeps ordering things the shop deliberately stopped selling.
--
-- Every existing row becomes ACTIVE. That is the one thing about existing
-- merchandise that is objectively knowable: nothing has ever been discontinued
-- here, because until now there was no way to say so. Nothing is inferred from
-- a name, a zero balance, or an absence of movement.
--
-- COEXISTENCE WITH `is_active`, and it is a bridge rather than a design. Both
-- columns now exist, and `is_active` is still the only one anything reads:
-- `findStockableVariant` and `listStockableVariants` are unchanged, so what may
-- be stocked and what appears on the stock screen behave exactly as they did
-- before this migration. `lifecycle_status` is inert — written by the default,
-- read by nobody.
--
-- Two flags for adjacent notions is precisely what INV-16 warns against, and it
-- is accepted here only because the alternative is worse: making lifecycle
-- authoritative in the same migration that introduces it would change
-- stockability underneath a deployed application that has no way to set it. PR 5
-- builds the lifecycle workflow and resolves the two into one, at which point
-- `is_active` goes or becomes derived. Until then, treat `is_active` as the
-- authority and this column as reserved.
--
-- text + CHECK, never a native enum (0001). The vocabulary is ADR 11's.

ALTER TABLE products
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE products
  ADD CONSTRAINT products_lifecycle_status_known CHECK (
    lifecycle_status IN ('ACTIVE', 'DISCONTINUED', 'ARCHIVED')
  );

-- Variants carry it too. A shop discontinues a colour without discontinuing the
-- model far more often than it retires the model itself, and the variant is the
-- level that is actually bought and sold. The two are independent: a
-- DISCONTINUED variant under an ACTIVE product is the ordinary case.
ALTER TABLE product_variants
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_lifecycle_status_known CHECK (
    lifecycle_status IN ('ACTIVE', 'DISCONTINUED', 'ARCHIVED')
  );

-- The DEFAULT stays. It is not a convenience for a backfill that has already
-- happened: the deployed backend inserts products and variants without naming
-- this column, and will keep doing so until PR 3 changes those statements. A
-- default removed here would be a NOT NULL violation on the next product
-- somebody creates.

COMMIT;
