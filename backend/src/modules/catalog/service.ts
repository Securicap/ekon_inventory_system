import type {
  CatalogMetadataResponse,
  CreateProductRequest,
  LifecycleStatus,
  Money,
  Product,
} from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError, conflict } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import {
  effectiveLifecycle,
  merchandisePolicy,
  type MerchandisePolicy,
} from './domain/lifecycle.js';
import { displayMerchandiseName, normalizeMerchandiseName } from './domain/merchandise.js';
import { generateSku as defaultGenerateSku } from './domain/sku.js';
import {
  AttributeNormalizationError,
  buildVariantSignature,
  normalizeAttributes,
  type NormalizedAttribute,
} from './domain/variantSignature.js';
import {
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
  listOperationalVariants,
  lockVariantLifecycle,
  resolveBrand,
  resolveClassificationValue,
  uniqueViolationConstraint,
  VARIANT_SIGNATURE_UNIQUE_CONSTRAINT,
  VARIANT_SKU_UNIQUE_CONSTRAINT,
  type ClassificationAssignment,
  type DimensionRecord,
  type OperationalVariantListing,
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
   * May stock be **booked in** against this variant, right now, in this
   * transaction? `null` when there is no such variant.
   *
   * This and its two siblings are how the inventory module asks about a
   * variant. It does not — and by lint rule cannot — query `product_variants`
   * itself: the catalog owns those tables, so the question crosses the boundary
   * as a call rather than as a join.
   *
   * **Three questions rather than one flag, and that is the whole point.** The
   * `isActive` this replaces could only say "available", which was enough while
   * one boolean governed everything and is wrong now: discontinued merchandise
   * may be sold and counted but not replenished. A workflow that asked a single
   * question would have to interpret the answer, and receiving and removal
   * would each be interpreting it separately. Here each workflow names what it
   * is about to do, and the catalog answers about *that* — receiving takes
   * `Pick<CatalogService, 'findVariantForReceiving'>` and so cannot reach the
   * issue rule even by accident.
   *
   * It answers only what a stock workflow has to decide before it posts, and
   * deliberately does not decide it: whether ineligible merchandise is a `404`
   * or a `409` is the calling workflow's rule, not the catalog's.
   *
   * **It takes the caller's transaction, and it locks.** The variant and its
   * product are read `FOR SHARE`, so a lifecycle change cannot commit between
   * this answer and the movement it authorizes — see `lockVariantLifecycle`.
   * That is what makes "archived merchandise never holds stock" an invariant
   * rather than a hope.
   */
  findVariantForReceiving(
    tx: DatabaseClient,
    variantId: string,
  ): Promise<MerchandiseEligibility | null>;
  /**
   * May stock be **taken off the shelf**? The counterpart to
   * `findVariantForReceiving`, and the reason there are two.
   *
   * `DISCONTINUED` merchandise answers `permitted: true` here and `false`
   * there. The shop stopped buying it; the units already on the shelf are still
   * sold to real customers, and a system that refused would leave stock
   * stranded — which does not stop it being sold, only being recorded.
   */
  findVariantForIssue(
    tx: DatabaseClient,
    variantId: string,
  ): Promise<MerchandiseEligibility | null>;
  /**
   * May its recorded history be **corrected** — adjusted, or a movement
   * reversed?
   *
   * A third question rather than reuse of either of the others, because a
   * correction is about ledger truth rather than about trade. `DISCONTINUED`
   * must not block one: discontinuing something on Friday cannot make Thursday's
   * mis-keyed receipt permanent. `ARCHIVED` does block one, because a correction
   * would put units back on a shelf the archive asserts is empty, behind a
   * status that has removed the merchandise from every operational screen. The
   * remedy is stated rather than implied: restore it, correct it, archive it
   * again.
   */
  findVariantForCorrection(
    tx: DatabaseClient,
    variantId: string,
  ): Promise<MerchandiseEligibility | null>;
  /**
   * Every variant still in day-to-day operation — `ACTIVE` or `DISCONTINUED`,
   * at both the variant and the product level — with the product name, SKU, and
   * attributes needed to label one.
   *
   * The plural counterpart to the eligibility questions, and it exists for the
   * same reason: the inventory module has to name what it holds stock of, and
   * the catalog owns the tables that say so. Current stock is composed from
   * this plus inventory's own locations and balances, in the inventory service
   * — which is why this returns the catalog side complete and unfiltered by
   * anything inventory knows, and decides nothing about stock.
   *
   * Discontinued merchandise **is** in this list. Replenishment stopping is not
   * a reason to hide what is on the shelf.
   */
  listOperationalVariants(): Promise<OperationalVariantListing[]>;
  /**
   * Labels for a known set of variant ids, in bulk, **regardless of their
   * lifecycle**.
   *
   * The third question the inventory module asks this one, and the first that
   * is about the past. `listOperationalVariants` answers "what can we hold
   * stock of", which is a present-tense operational question and filters
   * accordingly; stock history is evidence, and a movement against merchandise
   * the shop has since archived is exactly the record somebody goes looking
   * for. Answering history from the operational list would silently drop it.
   *
   * An unknown id is absent from the result rather than an error. The caller
   * holds permanent ledger ids and decides what a missing label means; the
   * catalog does not get to decide that a movement is unreadable.
   */
  findVariantLabels(variantIds: string[]): Promise<VariantLabel[]>;
}

/**
 * The catalog's answer to "may this variant take part in this operation?".
 *
 * One shape for all three questions, because a caller does the same three
 * things with any of them: report `404` when there is no such variant, report a
 * conflict naming the status when it is refused, and post when it is not.
 *
 * `lifecycleStatus` is the **effective** status — the stricter of the variant's
 * own and its parent product's — because that is the one that governs, and a
 * message naming the variant's own status while the product was the reason
 * would send somebody to fix the wrong row. Which of the two rows said so is
 * deliberately not reported: the remedy is the same either way, and the catalog
 * is where that is known.
 */
export interface MerchandiseEligibility {
  id: string;
  /** The product this variant belongs to. The relationship, not a lookup. */
  productId: string;
  /** Effective lifecycle: the stricter of the variant's and its product's. */
  lifecycleStatus: LifecycleStatus;
  /** Whether the operation that was asked about is permitted in that status. */
  permitted: boolean;
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
    findVariantForReceiving: (tx, variantId) =>
      variantEligibility(tx, variantId, (policy) => policy.mayReceive),
    findVariantForIssue: (tx, variantId) =>
      variantEligibility(tx, variantId, (policy) => policy.mayIssue),
    findVariantForCorrection: (tx, variantId) =>
      variantEligibility(tx, variantId, (policy) => policy.mayCorrect),
    listOperationalVariants: () => listOperationalVariants(pool),
    findVariantLabels: (variantIds) => findVariantLabels(pool, variantIds),
  };
}

/**
 * The one implementation behind all three eligibility questions.
 *
 * Reads and locks the two lifecycle rows once, combines them into the effective
 * status once, and asks the policy table which the caller named. Three thin
 * named methods over one honest lookup: the *names* keep workflows from asking
 * the wrong question, and a single body keeps the three answers from drifting.
 */
async function variantEligibility(
  tx: DatabaseClient,
  variantId: string,
  permits: (policy: MerchandisePolicy) => boolean,
): Promise<MerchandiseEligibility | null> {
  const found = await lockVariantLifecycle(tx, variantId);
  if (!found) return null;

  const lifecycleStatus = effectiveLifecycle(found.productStatus, found.variantStatus);
  return {
    id: found.id,
    productId: found.productId,
    lifecycleStatus,
    permitted: permits(merchandisePolicy(lifecycleStatus)),
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
