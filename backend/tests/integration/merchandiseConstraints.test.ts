import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createCatalogService } from '../../src/modules/catalog/index.js';
import { withTransaction } from '../../src/platform/db/unitOfWork.js';
import { productRequest } from '../helpers/catalogRequests.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * The constraints migration 0009 adds, exercised against a fully migrated
 * database. Each one is a rule that has to hold whatever the caller does, so
 * each is tested by trying to break it at the database rather than by asserting
 * that some service refuses first — there is no service for any of this yet.
 */

const NOW = new Date('2026-08-23T12:00:00.000Z');

describe('merchandise schema and constraints', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM variant_barcodes');
    await db.pool.query('DELETE FROM product_classifications');
    await db.pool.query('DELETE FROM classification_values');
    await db.pool.query('DELETE FROM variant_attributes');
    await db.pool.query('DELETE FROM product_variants');
    await db.pool.query('DELETE FROM products');
    await db.pool.query('DELETE FROM brands');
  });

  async function insertBrand(name: string, normalized = name.toLowerCase()): Promise<string> {
    const id = newId();
    await db.pool.query(
      `INSERT INTO brands (id, name, normalized_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [id, name, normalized, NOW],
    );
    return id;
  }

  async function insertProduct(brandId: string | null = null): Promise<string> {
    const id = newId();
    await db.pool.query(
      `INSERT INTO products (id, name, brand_id, created_at, updated_at)
       VALUES ($1, 'Bel Ami', $2, $3, $3)`,
      [id, brandId, NOW],
    );
    return id;
  }

  let skuCounter = 0;
  async function insertVariant(productId: string): Promise<string> {
    const id = newId();
    const sku = `EKN-V${(skuCounter++).toString().padStart(7, '0')}`;
    await db.pool.query(
      `INSERT INTO product_variants (id, product_id, sku, variant_signature, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, productId, sku, `[["n","${skuCounter}"]]`, NOW],
    );
    return id;
  }

  async function dimensionId(key: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM classification_dimensions WHERE key = $1`,
      [key],
    );
    return rows[0]!.id;
  }

  async function insertValue(dimension: string, value: string): Promise<string> {
    const id = newId();
    await db.pool.query(
      `INSERT INTO classification_values (id, dimension_id, value, normalized_value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, await dimensionId(dimension), value, value.toLowerCase(), NOW],
    );
    return id;
  }

  // Brands -----------------------------------------------------------------

  describe('brands', () => {
    it('treats two spellings of one brand as the same brand', async () => {
      await insertBrand('Steve Madden');
      await expect(insertBrand('STEVE MADDEN')).rejects.toThrow(/brands_normalized_name_unique/);
    });

    it('keeps the display case the shop entered', async () => {
      await insertBrand('Steve Madden');
      const { rows } = await db.pool.query<{ name: string; normalized_name: string }>(
        `SELECT name, normalized_name FROM brands`,
      );
      expect(rows[0]).toEqual({ name: 'Steve Madden', normalized_name: 'steve madden' });
    });

    it('refuses a normalized name that is not derived from the display name', async () => {
      await expect(insertBrand('Steve Madden', 'nike')).rejects.toThrow(
        /brands_normalized_name_derived/,
      );
    });

    it('refuses an untrimmed or blank name', async () => {
      await expect(insertBrand(' Nike ', ' nike ')).rejects.toThrow(/brands_name_trimmed/);
      await expect(insertBrand('', '')).rejects.toThrow(/brands_name_not_blank/);
    });

    it('refuses to delete a brand a product still names', async () => {
      const brandId = await insertBrand('Nike');
      await insertProduct(brandId);
      await expect(db.pool.query(`DELETE FROM brands WHERE id = $1`, [brandId])).rejects.toThrow(
        /violates foreign key constraint/,
      );
    });

    it('lets a product carry no brand at all', async () => {
      const productId = await insertProduct(null);
      const { rows } = await db.pool.query<{ brand_id: string | null }>(
        `SELECT brand_id FROM products WHERE id = $1`,
        [productId],
      );
      expect(rows[0]!.brand_id).toBeNull();
    });
  });

  // Classification ---------------------------------------------------------

  describe('classification', () => {
    it('refuses the same value twice in one dimension, whatever the case', async () => {
      await insertValue('category', 'Footwear');
      await expect(insertValue('category', 'FOOTWEAR')).rejects.toThrow(
        /classification_values_unique_in_dimension/,
      );
    });

    it('allows the same word as a value of two different dimensions', async () => {
      await insertValue('category', 'Footwear');
      await expect(insertValue('type', 'Footwear')).resolves.toBeDefined();
    });

    it('refuses an assignment whose value belongs to another dimension', async () => {
      const productId = await insertProduct();
      const footwear = await insertValue('category', 'Footwear');
      await expect(
        db.pool.query(
          `INSERT INTO product_classifications (product_id, dimension_id, value_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [productId, await dimensionId('audience'), footwear, NOW],
        ),
      ).rejects.toThrow(/product_classifications_value_in_dimension_fk/);
    });

    it('allows one value per dimension and refuses a second in the same dimension', async () => {
      const productId = await insertProduct();
      const category = await dimensionId('category');
      const footwear = await insertValue('category', 'Footwear');
      const handbags = await insertValue('category', 'Handbags');
      const kids = await insertValue('audience', 'Kids');

      await db.pool.query(
        `INSERT INTO product_classifications (product_id, dimension_id, value_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [productId, category, footwear, NOW],
      );
      // A different dimension is fine.
      await db.pool.query(
        `INSERT INTO product_classifications (product_id, dimension_id, value_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [productId, await dimensionId('audience'), kids, NOW],
      );
      // A second category is not.
      await expect(
        db.pool.query(
          `INSERT INTO product_classifications (product_id, dimension_id, value_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [productId, category, handbags, NOW],
        ),
      ).rejects.toThrow(/product_classifications_pkey/);
    });

    it('refuses to delete a classification value that is in use', async () => {
      const productId = await insertProduct();
      const footwear = await insertValue('category', 'Footwear');
      await db.pool.query(
        `INSERT INTO product_classifications (product_id, dimension_id, value_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [productId, await dimensionId('category'), footwear, NOW],
      );
      await expect(
        db.pool.query(`DELETE FROM classification_values WHERE id = $1`, [footwear]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('refuses a dimension key that is not a single canonical form', async () => {
      for (const key of ['Category', 'sub category', '1st', '']) {
        await expect(
          db.pool.query(
            `INSERT INTO classification_dimensions (id, key, name, created_at, updated_at)
             VALUES ($1, $2, 'X', $3, $3)`,
            [newId(), key, NOW],
          ),
        ).rejects.toThrow(/classification_dimensions_key_format/);
      }
    });

    it('refuses a duplicate dimension key', async () => {
      await expect(
        db.pool.query(
          `INSERT INTO classification_dimensions (id, key, name, created_at, updated_at)
           VALUES ($1, 'category', 'Category again', $2, $2)`,
          [newId(), NOW],
        ),
      ).rejects.toThrow(/classification_dimensions_key_unique/);
    });
  });

  // Controlled attribute definitions ---------------------------------------

  describe('variant attribute definitions', () => {
    async function define(name: string): Promise<void> {
      await db.pool.query(
        `INSERT INTO variant_attribute_definitions (id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $3)`,
        [newId(), name, NOW],
      );
    }

    it('carries the vocabulary 0010 seeded', async () => {
      const { rows } = await db.pool.query<{ name: string }>(
        `SELECT name FROM variant_attribute_definitions ORDER BY name`,
      );
      expect(rows.map((r) => r.name)).toEqual(['color', 'material', 'size', 'width']);
    });

    it('refuses the same attribute defined twice', async () => {
      await expect(define('color')).rejects.toThrow(/variant_attribute_definitions_name_unique/);
    });

    it('refuses a name that is not in the stored form variant_attributes uses', async () => {
      await expect(define('Color')).rejects.toThrow(
        /variant_attribute_definitions_name_normalized/,
      );
      await expect(define(' color ')).rejects.toThrow(
        /variant_attribute_definitions_name_normalized/,
      );
      await expect(define('')).rejects.toThrow(/variant_attribute_definitions_name_not_blank/);
    });

    it('bounds the name exactly as variant_attributes.attribute_name is bounded', async () => {
      await expect(define('a'.repeat(61))).rejects.toThrow(
        /variant_attribute_definitions_name_max_len/,
      );
      await expect(define('a'.repeat(60))).resolves.toBeUndefined();
    });

    it('refuses an attribute name nobody has defined (0010)', async () => {
      // The bridge 0009 left open, closed by 0010: the database itself now
      // refuses a new attribute name that is not in the vocabulary, so a
      // service that forgot to check is not the only thing standing between a
      // typo and permanent variant structure.
      const variantId = await insertVariant(await insertProduct());
      await expect(
        db.pool.query(
          `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
           VALUES ($1, 'undefined_attribute', 'x')`,
          [variantId],
        ),
      ).rejects.toThrow(/variant_attributes_name_defined_fk/);
    });

    it('accepts a defined attribute name', async () => {
      const variantId = await insertVariant(await insertProduct());
      await expect(
        db.pool.query(
          `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
           VALUES ($1, 'color', 'Black')`,
          [variantId],
        ),
      ).resolves.toBeDefined();
    });

    it('refuses to delete or rename a definition that is in use', async () => {
      const variantId = await insertVariant(await insertProduct());
      await db.pool.query(
        `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
         VALUES ($1, 'color', 'Black')`,
        [variantId],
      );
      await expect(
        db.pool.query(`DELETE FROM variant_attribute_definitions WHERE name = 'color'`),
      ).rejects.toThrow(/violates foreign key constraint/);
      // Renaming would rewrite the identity of every variant carrying one.
      await expect(
        db.pool.query(
          `UPDATE variant_attribute_definitions SET name = 'colour' WHERE name = 'color'`,
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  // Price and cost ---------------------------------------------------------

  describe('selling price and reference cost', () => {
    async function setAmounts(
      variantId: string,
      values: {
        price?: number | null;
        priceCurrency?: string | null;
        cost?: number | null;
        costCurrency?: string | null;
      },
    ): Promise<void> {
      await db.pool.query(
        `UPDATE product_variants
            SET selling_price_minor = $2, selling_price_currency = $3,
                reference_cost_minor = $4, reference_cost_currency = $5
          WHERE id = $1`,
        [
          variantId,
          values.price ?? null,
          values.priceCurrency ?? null,
          values.cost ?? null,
          values.costCurrency ?? null,
        ],
      );
    }

    let variantId: string;
    beforeEach(async () => {
      variantId = await insertVariant(await insertProduct());
    });

    it('is a bigint column, in minor units', async () => {
      const { rows } = await db.pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = 'product_variants'
            AND column_name IN ('selling_price_minor', 'reference_cost_minor')
          ORDER BY column_name`,
      );
      expect(rows).toEqual([
        { column_name: 'reference_cost_minor', data_type: 'bigint' },
        { column_name: 'selling_price_minor', data_type: 'bigint' },
      ]);

      await setAmounts(variantId, { price: 249_900, priceCurrency: 'HTG' });
      const { rows: stored } = await db.pool.query<{
        selling_price_minor: number;
        selling_price_currency: string;
      }>(`SELECT selling_price_minor, selling_price_currency FROM product_variants WHERE id = $1`, [
        variantId,
      ]);
      // 2 499,00 HTG stored as centimes. `pool.ts` parses int8 to a number.
      expect(stored[0]).toEqual({ selling_price_minor: 249900, selling_price_currency: 'HTG' });
    });

    it('holds an amount far larger than a 32-bit integer, exactly', async () => {
      await setAmounts(variantId, { price: 9_007_199_254_740_991, priceCurrency: 'HTG' });
      const { rows } = await db.pool.query<{ selling_price_minor: number }>(
        `SELECT selling_price_minor FROM product_variants WHERE id = $1`,
        [variantId],
      );
      expect(rows[0]!.selling_price_minor).toBe(9_007_199_254_740_991);
    });

    it('rejects a negative price and a negative cost', async () => {
      await expect(setAmounts(variantId, { price: -1, priceCurrency: 'HTG' })).rejects.toThrow(
        /product_variants_selling_price_non_negative/,
      );
      await expect(setAmounts(variantId, { cost: -1, costCurrency: 'USD' })).rejects.toThrow(
        /product_variants_reference_cost_non_negative/,
      );
    });

    it('rejects an amount without a currency, and a currency without an amount', async () => {
      await expect(setAmounts(variantId, { price: 100 })).rejects.toThrow(
        /product_variants_selling_price_complete/,
      );
      await expect(setAmounts(variantId, { priceCurrency: 'HTG' })).rejects.toThrow(
        /product_variants_selling_price_complete/,
      );
      await expect(setAmounts(variantId, { cost: 100 })).rejects.toThrow(
        /product_variants_reference_cost_complete/,
      );
      await expect(setAmounts(variantId, { costCurrency: 'USD' })).rejects.toThrow(
        /product_variants_reference_cost_complete/,
      );
    });

    it('rejects anything that is not an uppercase three-letter code', async () => {
      for (const currency of ['htg', 'US$', 'DOLLARS', ' HTG', 'HT']) {
        await expect(
          setAmounts(variantId, { price: 100, priceCurrency: currency }),
        ).rejects.toThrow(/product_variants_selling_price_currency_format/);
      }
    });

    it('accepts a currency it has never heard of, without a migration', async () => {
      await expect(
        setAmounts(variantId, { price: 100, priceCurrency: 'XPF' }),
      ).resolves.toBeUndefined();
    });

    it('lets price and cost be in different currencies', async () => {
      await setAmounts(variantId, {
        price: 249_900,
        priceCurrency: 'HTG',
        cost: 1_800,
        costCurrency: 'USD',
      });
      const { rows } = await db.pool.query<{
        selling_price_currency: string;
        reference_cost_currency: string;
      }>(
        `SELECT selling_price_currency, reference_cost_currency FROM product_variants WHERE id = $1`,
        [variantId],
      );
      expect(rows[0]).toEqual({ selling_price_currency: 'HTG', reference_cost_currency: 'USD' });
    });

    it('represents "not established yet" as NULL, distinctly from zero', async () => {
      const { rows: unset } = await db.pool.query<{ selling_price_minor: number | null }>(
        `SELECT selling_price_minor FROM product_variants WHERE id = $1`,
        [variantId],
      );
      expect(unset[0]!.selling_price_minor).toBeNull();

      // Zero is a different fact — the item is free — and it stores as zero.
      await setAmounts(variantId, { price: 0, priceCurrency: 'HTG' });
      const { rows: free } = await db.pool.query<{ selling_price_minor: number | null }>(
        `SELECT selling_price_minor FROM product_variants WHERE id = $1`,
        [variantId],
      );
      expect(free[0]!.selling_price_minor).toBe(0);
    });
  });

  // Barcodes ---------------------------------------------------------------

  describe('barcodes', () => {
    async function addBarcode(variantId: string, barcode: string): Promise<void> {
      await db.pool.query(
        `INSERT INTO variant_barcodes (id, variant_id, barcode, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [newId(), variantId, barcode, NOW],
      );
    }

    it('lets one variant carry several identifiers', async () => {
      const variantId = await insertVariant(await insertProduct());
      await addBarcode(variantId, '0885140123456');
      await addBarcode(variantId, 'DIST-99A');
      const { rows } = await db.pool.query<{ barcode: string }>(
        `SELECT barcode FROM variant_barcodes WHERE variant_id = $1 ORDER BY barcode`,
        [variantId],
      );
      expect(rows.map((r) => r.barcode)).toEqual(['0885140123456', 'DIST-99A']);
    });

    it('refuses the same identifier twice on one variant', async () => {
      const variantId = await insertVariant(await insertProduct());
      await addBarcode(variantId, '0885140123456');
      await expect(addBarcode(variantId, '0885140123456')).rejects.toThrow(
        /variant_barcodes_variant_barcode_unique/,
      );
    });

    it('allows the same identifier on two variants, because the world does', async () => {
      const productId = await insertProduct();
      const first = await insertVariant(productId);
      const second = await insertVariant(productId);
      await addBarcode(first, '0885140123456');
      // Deliberately not globally unique: a manufacturer code is somebody
      // else's identifier and carries none of the SKU's guarantees.
      await expect(addBarcode(second, '0885140123456')).resolves.toBeUndefined();
    });

    it('refuses a blank, padded, or whitespace-bearing identifier', async () => {
      const variantId = await insertVariant(await insertProduct());
      await expect(addBarcode(variantId, '')).rejects.toThrow(/variant_barcodes_not_blank/);
      await expect(addBarcode(variantId, ' 088514 ')).rejects.toThrow(/variant_barcodes_no_space/);
      await expect(addBarcode(variantId, '0885 140')).rejects.toThrow(/variant_barcodes_no_space/);
      await expect(addBarcode(variantId, '0885\t140')).rejects.toThrow(/variant_barcodes_no_space/);
      await expect(addBarcode(variantId, 'X'.repeat(65))).rejects.toThrow(
        /variant_barcodes_max_len/,
      );
    });

    it('refuses to delete a variant that carries an identifier', async () => {
      const variantId = await insertVariant(await insertProduct());
      await addBarcode(variantId, '0885140123456');
      await expect(
        db.pool.query(`DELETE FROM product_variants WHERE id = $1`, [variantId]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('does not replace the SKU', async () => {
      // A barcode is an alternate key onto a variant; the SKU is still the
      // identity, still unique, and still immutable (INV-13).
      const variantId = await insertVariant(await insertProduct());
      await addBarcode(variantId, '0885140123456');
      await expect(
        db.pool.query(`UPDATE product_variants SET sku = 'EKN-NEWSKU1' WHERE id = $1`, [variantId]),
      ).rejects.toThrow(/immutable/);
    });
  });

  // Lifecycle --------------------------------------------------------------

  describe('lifecycle', () => {
    it('defaults a new product and variant to ACTIVE', async () => {
      const productId = await insertProduct();
      const variantId = await insertVariant(productId);
      const product = await db.pool.query<{ lifecycle_status: string }>(
        `SELECT lifecycle_status FROM products WHERE id = $1`,
        [productId],
      );
      const variant = await db.pool.query<{ lifecycle_status: string }>(
        `SELECT lifecycle_status FROM product_variants WHERE id = $1`,
        [variantId],
      );
      expect(product.rows[0]!.lifecycle_status).toBe('ACTIVE');
      expect(variant.rows[0]!.lifecycle_status).toBe('ACTIVE');
    });

    it('accepts only the three approved values', async () => {
      const productId = await insertProduct();
      for (const status of ['ACTIVE', 'DISCONTINUED', 'ARCHIVED']) {
        await expect(
          db.pool.query(`UPDATE products SET lifecycle_status = $2 WHERE id = $1`, [
            productId,
            status,
          ]),
        ).resolves.toBeDefined();
      }
      for (const status of ['active', 'DELETED', 'INACTIVE', '']) {
        await expect(
          db.pool.query(`UPDATE products SET lifecycle_status = $2 WHERE id = $1`, [
            productId,
            status,
          ]),
        ).rejects.toThrow(/products_lifecycle_status_known/);
      }
    });

    it('lets a variant be discontinued while its product stays active', async () => {
      const productId = await insertProduct();
      const variantId = await insertVariant(productId);
      await db.pool.query(
        `UPDATE product_variants SET lifecycle_status = 'DISCONTINUED' WHERE id = $1`,
        [variantId],
      );
      const { rows } = await db.pool.query<{ product: string; variant: string }>(
        `SELECT p.lifecycle_status AS product, v.lifecycle_status AS variant
           FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE v.id = $1`,
        [variantId],
      );
      expect(rows[0]).toEqual({ product: 'ACTIVE', variant: 'DISCONTINUED' });
    });

    it('makes lifecycle the authority on what may be stocked', async () => {
      // The bridge 0009 opened and 0012 closed. `is_active` is gone from both
      // tables, and the lifecycle columns are what the catalog now answers
      // from — including the parent product's, which is a ceiling on its
      // variants.
      const catalog = createCatalogService({ pool: db.pool, clock: fixedClock(NOW) });
      const productId = await insertProduct();
      const variantId = await insertVariant(productId);

      await withTransaction(db.pool, async (tx) => {
        expect(await catalog.findVariantForReceiving(tx, variantId)).toMatchObject({
          lifecycleStatus: 'ACTIVE',
          permitted: true,
        });
      });

      await db.pool.query(`UPDATE products SET lifecycle_status = 'ARCHIVED' WHERE id = $1`, [
        productId,
      ]);

      await withTransaction(db.pool, async (tx) => {
        // The variant's own row still says ACTIVE; its effective status does not.
        expect(await catalog.findVariantForReceiving(tx, variantId)).toMatchObject({
          lifecycleStatus: 'ARCHIVED',
          permitted: false,
        });
        expect(await catalog.findVariantForIssue(tx, variantId)).toMatchObject({
          permitted: false,
        });
      });
    });

    it('no longer has an is_active column on products or variants', async () => {
      // The whole point of retiring the bridge: one authority, not two adjacent
      // ones. A column nothing reads is a column somebody starts reading again.
      const { rows } = await db.pool.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name = 'is_active'
            AND table_name IN ('products', 'product_variants')`,
      );
      expect(rows).toEqual([]);
    });

    it('keeps is_active where it is a different fact entirely', async () => {
      // Users and locations are untouched: whether a person may sign in
      // (INV-16) and whether a shelf is open (0004) are not merchandise
      // lifecycle, and neither has a lifecycle column to be reconciled with.
      const { rows } = await db.pool.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'is_active'
          ORDER BY table_name`,
      );
      expect(rows.map((row) => row.table_name)).toEqual(['inventory_locations', 'users']);
    });
  });

  // Application compatibility ----------------------------------------------

  describe('the catalog write path', () => {
    it('creates a product with variants and attributes', async () => {
      const catalog = createCatalogService({ pool: db.pool, clock: fixedClock(NOW) });
      const product = await catalog.createProduct(
        productRequest({
          name: 'Bel Ami',
          variants: [{ attributes: { color: 'Black', size: '8' } }],
        }),
      );

      expect(product.variants).toHaveLength(1);
      expect(product.variants[0]!.sku).toMatch(/^EKN-[0-9A-Z]{8}$/);
      expect(product.variants[0]!.attributes).toEqual([
        { name: 'color', value: 'Black' },
        { name: 'size', value: '8' },
      ]);

      // Everything 0009 added is unset, and the defaults it relies on applied.
      const { rows } = await db.pool.query<{
        brand_id: string | null;
        product_lifecycle: string;
        variant_lifecycle: string;
        selling_price_minor: number | null;
        reference_cost_minor: number | null;
      }>(
        `SELECT p.brand_id, p.lifecycle_status AS product_lifecycle,
                v.lifecycle_status AS variant_lifecycle,
                v.selling_price_minor, v.reference_cost_minor
           FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE p.id = $1`,
        [product.id],
      );
      expect(rows[0]).toEqual({
        brand_id: null,
        product_lifecycle: 'ACTIVE',
        variant_lifecycle: 'ACTIVE',
        selling_price_minor: null,
        reference_cost_minor: null,
      });
    });

    it('still lists the catalog', async () => {
      const catalog = createCatalogService({ pool: db.pool, clock: fixedClock(NOW) });
      await catalog.createProduct(productRequest({ name: 'Bel Ami' }));
      const products = await catalog.listProducts();
      expect(products).toHaveLength(1);
      expect(products[0]!.variants).toHaveLength(1);
    });
  });
});
