import type { CreateProductRequest, Product } from '@ekon/shared';
import type { Clock } from '../../platform/clock/index.js';
import type { DatabaseClient, DatabasePool } from '../../platform/db/pool.js';
import { withTransaction } from '../../platform/db/unitOfWork.js';
import { AppError, conflict } from '../../platform/http/errors.js';
import { newId } from '../../platform/ids/uuidv7.js';
import { generateSku as defaultGenerateSku } from './domain/sku.js';
import {
  AttributeNormalizationError,
  buildVariantSignature,
  normalizeAttributes,
  type NormalizedAttribute,
} from './domain/variantSignature.js';
import {
  getProductById,
  insertProduct,
  insertVariant,
  insertVariantAttributes,
  listCatalog,
  uniqueViolationConstraint,
  VARIANT_SIGNATURE_UNIQUE_CONSTRAINT,
  VARIANT_SKU_UNIQUE_CONSTRAINT,
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
}

/** A SKU collision is astronomically unlikely; a few retries is ample and bounded. */
const MAX_SKU_ATTEMPTS = 5;

export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const { pool, clock } = deps;
  const generateSku = deps.generateSku ?? defaultGenerateSku;

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
      await insertProduct(tx, {
        id: productId,
        name: input.name,
        description,
        createdAt: now,
        updatedAt: now,
      });

      for (const variant of prepared) {
        const variantId = newId();
        await insertVariantWithUniqueSku(tx, {
          id: variantId,
          productId,
          variantSignature: variant.signature,
          createdAt: now,
        });
        await insertVariantAttributes(tx, variantId, variant.attributes);
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

  /**
   * Inserts a variant, retrying with a fresh SKU only on a SKU uniqueness
   * collision, isolated by a savepoint so the surrounding transaction survives.
   * Any other failure propagates and rolls the whole product back.
   */
  async function insertVariantWithUniqueSku(
    tx: DatabaseClient,
    base: { id: string; productId: string; variantSignature: string; createdAt: Date },
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

  return { createProduct, listProducts };
}

interface PreparedVariant {
  attributes: NormalizedAttribute[];
  signature: string;
}

function prepareVariants(variants: CreateProductRequest['variants']): PreparedVariant[] {
  const details: { path: string; message: string }[] = [];
  const prepared: PreparedVariant[] = [];

  variants.forEach((variant, index) => {
    try {
      const attributes = normalizeAttributes(variant.attributes, `variants.${index}.attributes`);
      prepared.push({ attributes, signature: buildVariantSignature(attributes) });
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
