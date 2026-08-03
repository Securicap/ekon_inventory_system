-- 0002_catalog.sql
--
-- Catalog: the things the business can stock. A `product` is the general item;
-- a `product_variant` is a specific sellable form of it (a size, a colour, or —
-- for a plain item — a single default variant with no attributes). Inventory is
-- always held per variant, never against a product directly, which is why every
-- product created here has at least one variant.
--
-- Scope of this migration is deliberately narrow. It creates the catalog tables
-- and the constraints that protect them. It does NOT create inventory movement,
-- balance, or audit tables — those arrive with the ledger.
--
-- Conventions from 0001 apply: uuid primary keys generated in application code
-- (no database defaults), timestamptz everywhere, boolean NOT NULL DEFAULT,
-- text + CHECK instead of native enums, ON DELETE RESTRICT onto rows that carry
-- history, and no JSON store for structured data.

BEGIN;

-- Products -----------------------------------------------------------------

CREATE TABLE products (
  id          uuid        PRIMARY KEY,
  name        text        NOT NULL,
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,

  -- Name is required after trimming and bounded. The application trims before
  -- insert; these checks make the invariant true regardless of the caller.
  CONSTRAINT products_name_trimmed   CHECK (name = btrim(name)),
  CONSTRAINT products_name_not_blank CHECK (length(name) > 0),
  CONSTRAINT products_name_max_len   CHECK (length(name) <= 200)
);

-- Product variants ---------------------------------------------------------

CREATE TABLE product_variants (
  id                uuid        PRIMARY KEY,
  product_id        uuid        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  sku               text        NOT NULL,
  variant_signature text        NOT NULL,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,

  -- SKUs are server-generated: EKN- followed by eight uppercase characters.
  CONSTRAINT product_variants_sku_format CHECK (sku ~ '^EKN-[0-9A-Z]{8}$'),

  -- SKUs are globally unique; they end up on physical shelf labels.
  CONSTRAINT product_variants_sku_unique UNIQUE (sku),

  -- A product cannot hold two variants with the same normalized attribute set.
  -- The database, not only the application, enforces this.
  CONSTRAINT product_variants_signature_unique UNIQUE (product_id, variant_signature)
);

-- Supports listing a product's variants and the foreign key from attributes.
-- Postgres does not index a foreign-key column automatically.
CREATE INDEX product_variants_product_id_idx ON product_variants (product_id);

-- Variant attributes -------------------------------------------------------
--
-- A thin key/value table on purpose. There is deliberately no attribute
-- definition, option-set, category, or template table: that generic engine is
-- the classic inventory-system over-engineering trap. If controlled
-- vocabularies are ever needed they can be added and backfilled.

CREATE TABLE variant_attributes (
  variant_id      uuid NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  attribute_name  text NOT NULL,
  attribute_value text NOT NULL,

  -- One value per attribute name per variant. The primary key also indexes
  -- lookups by variant_id, so no separate index is needed.
  PRIMARY KEY (variant_id, attribute_name),

  -- Names are stored already normalized (trimmed + lower-cased); values are
  -- stored trimmed with case preserved. These checks mirror the application's
  -- normalization so the stored form cannot drift from it.
  CONSTRAINT variant_attributes_name_normalized CHECK (attribute_name = lower(btrim(attribute_name))),
  CONSTRAINT variant_attributes_name_not_blank  CHECK (length(attribute_name) > 0),
  CONSTRAINT variant_attributes_name_max_len    CHECK (length(attribute_name) <= 60),
  CONSTRAINT variant_attributes_value_trimmed   CHECK (attribute_value = btrim(attribute_value)),
  CONSTRAINT variant_attributes_value_not_blank CHECK (length(attribute_value) > 0),
  CONSTRAINT variant_attributes_value_max_len   CHECK (length(attribute_value) <= 120)
);

-- SKU immutability ---------------------------------------------------------
--
-- A SKU is printed on a shelf label the moment a variant exists, so it must
-- never change. Enforced at the database, not only in application code, with a
-- small trigger scoped to this one column. This is not a general-purpose
-- immutable-column framework.

CREATE FUNCTION catalog_reject_sku_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sku IS DISTINCT FROM OLD.sku THEN
    RAISE EXCEPTION 'product_variants.sku is immutable (attempted to change % to %)', OLD.sku, NEW.sku
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_variants_sku_immutable
  BEFORE UPDATE ON product_variants
  FOR EACH ROW
  EXECUTE FUNCTION catalog_reject_sku_change();

COMMIT;
