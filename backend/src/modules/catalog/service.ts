import type { CatalogMetadataResponse, CreateProductRequest, Money, Product } from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError, conflict } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import { displayMerchandiseName, normalizeMerchandiseName } from './domain/merchandise.js';
import { generateSku as defaultGenerateSku } from './domain/sku.js';
import {
  AttributeNormalizationError,
  buildVariantSignature,
  normalizeAttributes,
  type NormalizedAttribute,
} from './domain/variantSignature.js';
import {
  findStockableVariant,
  findVariantLabels,
  getProductById,
  insertProduct,
  insertProductClassifications,
  insertVariant,
  insertVariantAttributes,
  insertVariantBarcodes,
  listAttributeDefinitions,
  listBrands,
  listCatalog,
  listClassificationDimensions,
  listDimensions,
  listStockableVariants,
  resolveBrand,
  resolveClassificationValue,
  uniqueViolationConstraint,
  VARIANT_SIGNATURE_UNIQUE_CONSTRAINT,
  VARIANT_SKU_UNIQUE_CONSTRAINT,
  type ClassificationAssignment,
  type DimensionRecord,
  type StockableVariant,
  type StockableVariantListing,
  type VariantLabel,
} from './infrastructure/catalogRepository.js';

/**
 * The catalog application service — the module's public surface. Routes call it;
 * other modules would call it too rather than touching catalog tables directly.
 *
 * Dependencies are injected so behaviour is testable: a fixed clock gives
 * deterministic timestamps, and a stubbed SKU generator can force the
 * collision path in tests.
 */
export interface CatalogServiceDeps {
  pool: DatabasePool;
  clock: Clock;
  /** Overridable only for tests; production uses the real CSPRNG generator. */
  generateSku?: (() => string) | undefined;
}

export interface CatalogService {
  createProduct(input: CreateProductRequest): Promise<Product>;
  listProducts(): Promise<Product[]>;
  /**
   * What the catalog already knows: its brands, its classification dimensions
   * and their values, and the controlled attribute names. Read-only — nothing
   * here is created except as a side effect of entering merchandise.
   */
  getMetadata(): Promise<CatalogMetadataResponse>;
  /**
   * Whether a variant exists and may still be stocked. `null` when there is no
   * such variant.
   *
   * This is how the inventory module asks about a variant. It does not — and by
   * lint rule cannot — query `product_variants` itself: the catalog owns those
   * tables, so the question crosses the boundary as a call rather than as a
   * join. It answers only what a stock workflow has to decide before it posts,
   * and deliberately does not decide it: whether an unstockable variant is a
   * `404` or a `409` is the calling workflow's rule, not the catalog's.
   *
   * The returned `isActive` is **effective stockability** — the variant and its
   * parent product both active — and not the `product_variants.is_active`
   * column on its own. It does **not** consult `lifecycle_status`, and the
   * merchandise model did not change that: lifecycle is inert until PR 5.
   * `null` still means only "no such variant".
   */
  findStockableVariant(variantId: string): Promise<StockableVariant | null>;
  /**
   * Every variant that may currently be stocked — active variants of active
   * products — with the product name, SKU, and attributes needed to label one.
   *
   * The plural counterpart to `findStockableVariant`, and it exists for the same
   * reason: the inventory module has to name what it holds stock of, and the
   * catalog owns the tables that say so. Current stock is composed from this
   * plus inventory's own locations and balances, in the inventory service —
   * which is why this returns the catalog side complete and unfiltered by
   * anything inventory knows, and decides nothing about stock.
   */
  listStockableVariants(): Promise<StockableVariantListing[]>;
  /**
   * Labels for a known set of variant ids, in bulk, **regardless of whether any
   * of them may be stocked today**.
   *
   * The third question the inventory module asks this one, and the first that
   * is about the past. `listStockableVariants` answers "what can we hold stock
   * of", which is a present-tense operational question and filters accordingly;
   * stock history is evidence, and a movement against merchandise the shop has
   * since retired is exactly the record somebody goes looking for. Answering
   * history from the stockable list would silently drop it.
   *
   * An unknown id is absent from the result rather than an error. The caller
   * holds permanent ledger ids and decides what a missing label means; the
   * catalog does not get to decide that a movement is unreadable.
   */
  findVariantLabels(variantIds: string[]): Promise<VariantLabel[]>;
}

/** A SKU collision is astronomically unlikely; a few retries is ample and bounded. */
const MAX_SKU_ATTEMPTS = 5;

export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const { pool, clock } = deps;
  const generateSku = deps.generateSku ?? defaultGenerateSku;

  /**
   * Creates a product and everything that belongs to it, in one transaction.
   *
   * The order is: settle what is purely structural before opening a transaction,
   * then resolve the merchandise vocabulary, then write. A request whose
   * attributes do not normalize never reaches the database at all.
   *
   * Inside the transaction, resolving comes first and writing second, so a
   * request naming an unknown classification dimension or an undefined attribute
   * fails before a single row exists. Everything after that either commits
   * together — brand, classifications, product, variants, attributes, prices,
   * barcodes — or leaves nothing behind (INV-5's discipline, applied to
   * merchandise rather than to the ledger).
   */
  async function createProduct(input: CreateProductRequest): Promise<Product> {
    const now = clock.now();

    // Normalize every variant's attributes and derive its signature before
    // touching the database, so a bad request never opens a transaction.
    const prepared = prepareVariants(input.variants);
    assertNoDuplicateSignatures(prepared);

    const productId = newId();
    const description =
      input.description && input.description.length > 0 ? input.description : null;

    return withTransaction(pool, async (tx) => {
      await assertAttributeNamesAreDefined(tx, prepared);

      const brand = input.brand ? await resolveRequestedBrand(tx, input.brand, now) : null;
      const classifications = await resolveClassifications(tx, input.classifications, now);

      await insertProduct(tx, {
        id: productId,
        name: input.name,
        description,
        brandId: brand?.id ?? null,
        createdAt: now,
        updatedAt: now,
      });
      await insertProductClassifications(tx, productId, classifications, now);

      for (const variant of prepared) {
        const variantId = newId();
        await insertVariantWithUniqueSku(tx, {
          id: variantId,
          productId,
          variantSignature: variant.signature,
          sellingPrice: variant.sellingPrice,
          referenceCost: variant.referenceCost,
          createdAt: now,
        });
        await insertVariantAttributes(tx, variantId, variant.attributes);
        await insertVariantBarcodes(
          tx,
          variantId,
          variant.barcodes.map((barcode) => ({ id: newId(), barcode })),
          now,
        );
      }

      const created = await getProductById(tx, productId);
      // Unreachable: the product was just inserted in this transaction.
      if (!created) throw new Error('Product vanished within its own transaction');
      return created;
    });
  }

  async function listProducts(): Promise<Product[]> {
    return listCatalog(pool);
  }

  async function getMetadata(): Promise<CatalogMetadataResponse> {
    const [brands, classificationDimensions, variantAttributeDefinitions] = await Promise.all([
      listBrands(pool),
      listClassificationDimensions(pool),
      listAttributeDefinitions(pool),
    ]);
    return { brands, classificationDimensions, variantAttributeDefinitions };
  }

  /**
   * A brand is **resolved, not created on sight**: an existing normalized name
   * wins, and only a genuinely new one becomes a row. The id minted here is
   * spent only if the insert actually creates something, which is the ordinary
   * cost of generating ids in application code (0001) rather than in the
   * database.
   */
  async function resolveRequestedBrand(
    tx: DatabaseClient,
    requested: string,
    now: Date,
  ): Promise<{ id: string; name: string }> {
    return resolveBrand(tx, {
      id: newId(),
      name: displayMerchandiseName(requested),
      normalizedName: normalizeMerchandiseName(requested),
      now,
    });
  }

  /**
   * Turns `{ category: "Footwear" }` into the rows a product is filed under.
   *
   * **An unknown dimension key is refused; an unknown value is created.** The
   * asymmetry is the whole controlled-classification rule: which kinds of
   * grouping exist is a decision about the merchandise model, and one product
   * form should not be able to invent `colour_family` by typo. Which values a
   * dimension holds is the shop's own data — `Sandals` entered for the first
   * time is a new sandal category, not a mistake.
   */
  async function resolveClassifications(
    tx: DatabaseClient,
    requested: CreateProductRequest['classifications'],
    now: Date,
  ): Promise<ClassificationAssignment[]> {
    const entries = Object.entries(requested);
    if (entries.length === 0) return [];

    const dimensions = await listDimensions(tx);
    const byKey = new Map<string, DimensionRecord>(dimensions.map((d) => [d.key, d]));

    const details: { path: string; message: string }[] = [];
    for (const [key] of entries) {
      if (!byKey.has(key)) {
        details.push({
          path: `classifications.${key}`,
          message:
            `Unknown classification dimension "${key}". ` +
            `Known dimensions: ${dimensions.map((d) => d.key).join(', ')}`,
        });
      }
    }
    if (details.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Request validation failed', details);
    }

    const assignments: ClassificationAssignment[] = [];
    for (const [key, value] of entries) {
      const dimension = byKey.get(key)!;
      const valueId = await resolveClassificationValue(tx, {
        id: newId(),
        dimensionId: dimension.id,
        value: displayMerchandiseName(value),
        normalizedValue: normalizeMerchandiseName(value),
        now,
      });
      assignments.push({ dimensionId: dimension.id, valueId });
    }
    return assignments;
  }

  /**
   * Attribute names come from the vocabulary, and an unknown one is refused
   * rather than defined.
   *
   * The opposite of how brands and classification values are handled, and for a
   * reason worth stating: an attribute name is **structure**. `color` is the
   * shape variant identity takes across every product in the catalog, and it is
   * baked into `variant_signature` permanently. A shop that can create one by
   * typing it ends up with `color`, `colour`, and `couleur` describing the same
   * thing, and no report by colour is possible again. A brand or a category is
   * data about one product and costs nothing to add.
   *
   * The database refuses the same write regardless
   * (`variant_attributes_name_defined_fk`, 0010). This check exists so the
   * caller gets a field-level message naming what it may use, instead of a
   * foreign-key error.
   */
  async function assertAttributeNamesAreDefined(
    tx: DatabaseClient,
    variants: PreparedVariant[],
  ): Promise<void> {
    const used = new Set(variants.flatMap((v) => v.attributes.map((a) => a.name)));
    if (used.size === 0) return;

    const definitions = await listAttributeDefinitions(tx);
    const defined = new Set(definitions.map((d) => d.name));

    const details: { path: string; message: string }[] = [];
    variants.forEach((variant, index) => {
      for (const attribute of variant.attributes) {
        if (defined.has(attribute.name)) continue;
        details.push({
          path: `variants.${index}.attributes.${attribute.name}`,
          message:
            `Unknown attribute "${attribute.name}". ` +
            `Defined attributes: ${definitions.map((d) => d.name).join(', ')}`,
        });
      }
    });

    if (details.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Request validation failed', details);
    }
  }

  /**
   * Inserts a variant, retrying with a fresh SKU only on a SKU uniqueness
   * collision, isolated by a savepoint so the surrounding transaction survives.
   * Any other failure propagates and rolls the whole product back.
   */
  async function insertVariantWithUniqueSku(
    tx: DatabaseClient,
    base: {
      id: string;
      productId: string;
      variantSignature: string;
      sellingPrice: Money | null;
      referenceCost: Money | null;
      createdAt: Date;
    },
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_SKU_ATTEMPTS; attempt += 1) {
      const sku = generateSku();
      await tx.query('SAVEPOINT variant_insert');
      try {
        await insertVariant(tx, { ...base, sku, updatedAt: base.createdAt });
        await tx.query('RELEASE SAVEPOINT variant_insert');
        return;
      } catch (error) {
        const constraint = uniqueViolationConstraint(error);
        if (constraint === VARIANT_SKU_UNIQUE_CONSTRAINT) {
          await tx.query('ROLLBACK TO SAVEPOINT variant_insert');
          continue;
        }
        if (constraint === VARIANT_SIGNATURE_UNIQUE_CONSTRAINT) {
          // Defense in depth: duplicates are rejected before the transaction,
          // so reaching here means a concurrent writer — surface it as a conflict.
          throw conflict('A variant with the same attributes already exists for this product');
        }
        throw error;
      }
    }
    throw conflict('Could not allocate a unique SKU after several attempts');
  }

  return {
    createProduct,
    listProducts,
    getMetadata,
    findStockableVariant: (variantId) => findStockableVariant(pool, variantId),
    listStockableVariants: () => listStockableVariants(pool),
    findVariantLabels: (variantIds) => findVariantLabels(pool, variantIds),
  };
}

interface PreparedVariant {
  attributes: NormalizedAttribute[];
  signature: string;
  sellingPrice: Money | null;
  referenceCost: Money | null;
  barcodes: string[];
}

function prepareVariants(variants: CreateProductRequest['variants']): PreparedVariant[] {
  const details: { path: string; message: string }[] = [];
  const prepared: PreparedVariant[] = [];

  variants.forEach((variant, index) => {
    try {
      const attributes = normalizeAttributes(variant.attributes, `variants.${index}.attributes`);
      prepared.push({
        attributes,
        signature: buildVariantSignature(attributes),
        sellingPrice: variant.sellingPrice ?? null,
        referenceCost: variant.referenceCost ?? null,
        barcodes: variant.barcodes,
      });
    } catch (error) {
      if (error instanceof AttributeNormalizationError) {
        details.push(...error.details);
      } else {
        throw error;
      }
    }
  });

  if (details.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed', details);
  }
  return prepared;
}

function assertNoDuplicateSignatures(variants: PreparedVariant[]): void {
  const seen = new Map<string, number>();
  const details: { path: string; message: string }[] = [];

  variants.forEach((variant, index) => {
    const firstIndex = seen.get(variant.signature);
    if (firstIndex !== undefined) {
      details.push({
        path: `variants.${index}`,
        message: `Duplicate variant: same attributes as variant ${firstIndex}`,
      });
    } else {
      seen.set(variant.signature, index);
    }
  });

  if (details.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed', details);
  }
}
