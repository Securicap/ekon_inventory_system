-- 0003_variant_value_case_insensitivity.sql
--
-- Variant identity becomes case-insensitive on attribute VALUES. "White",
-- "white", and " WHITE " are the same stockable variant — capitalization and
-- surrounding whitespace are data-entry differences, not distinct variants.
--
-- Only the identity key changes. `variant_signature` is recomputed to use
-- lower-cased values; the stored `attribute_value` keeps its trimmed display
-- case and is never rewritten. Attribute names were already case-insensitive
-- (stored lower-cased since 0002). Migrations 0001 and 0002 are untouched.
--
-- Canonical serialization: the signature string must be byte-for-byte identical
-- to the application's `JSON.stringify` of the sorted `[name, value]` pairs — a
-- JSON array with no incidental spaces. PostgreSQL's json/jsonb `::text` inserts
-- spaces, so the brackets and commas are assembled by hand while each name and
-- value is quoted with `to_json(...)::text`, which escapes exactly as
-- `JSON.stringify` does. Names sort with `COLLATE "C"` to match JavaScript's
-- code-point string ordering (a linguistic collation would reorder). Values use
-- `lower(btrim(...))` — ordinary Unicode lower-casing that, for the Latin-script
-- values this catalog holds, agrees with JavaScript's `toLowerCase()`.

BEGIN;

-- The new signature for every existing variant, computed once. A default
-- variant (no attributes) yields '[]'. Dropped automatically at COMMIT.
CREATE TEMPORARY TABLE _catalog_new_signatures ON COMMIT DROP AS
SELECT
  pv.id AS variant_id,
  pv.product_id AS product_id,
  COALESCE(
    '['
      || string_agg(
           '[' || to_json(va.attribute_name)::text
               || ',' || to_json(lower(btrim(va.attribute_value)))::text || ']',
           ','
           ORDER BY va.attribute_name COLLATE "C"
         )
      || ']',
    '[]'
  ) AS signature
FROM product_variants pv
LEFT JOIN variant_attributes va ON va.variant_id = pv.id
GROUP BY pv.id, pv.product_id;

-- Preflight. If two variants of the same product would share a signature under
-- the new rule, abort loudly and change nothing. We do not pick a winner, merge
-- variants, delete rows, or touch SKUs — a human must resolve genuine
-- case-insensitive duplicates first. Because this runs inside the transaction,
-- the exception rolls the whole migration back with no partial updates.
DO $$
DECLARE
  offending RECORD;
BEGIN
  SELECT product_id, signature, count(*) AS variant_count
    INTO offending
    FROM _catalog_new_signatures
   GROUP BY product_id, signature
  HAVING count(*) > 1
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Case-insensitive variant migration aborted: product % has % variants that collapse to the same signature %. Resolve these duplicate variants manually before applying this migration.',
      offending.product_id, offending.variant_count, offending.signature;
  END IF;
END $$;

-- Recompute in a single statement: all-or-nothing. Only rows whose signature
-- actually changes are written, so a re-run would be a genuine no-op.
UPDATE product_variants pv
   SET variant_signature = ns.signature
  FROM _catalog_new_signatures ns
 WHERE pv.id = ns.variant_id
   AND pv.variant_signature IS DISTINCT FROM ns.signature;

COMMIT;
