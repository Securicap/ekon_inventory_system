import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProductResponseSchema,
  LIFECYCLE_STATUSES,
  movementHistoryPageSchema,
  productSchema,
  productVariantSchema,
  type ErrorBody,
  type LifecycleStatus,
  type Product,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * Merchandise lifecycle, end to end: `PATCH /api/catalog/products/:id/lifecycle`
 * and `PATCH /api/catalog/variants/:id/lifecycle`, and what each status then
 * means to every workflow that touches stock.
 *
 * Three things are being held here, and they are the three that would be
 * expensive to get wrong:
 *
 *  1. **Discontinued merchandise stays operational.** No longer bought is not
 *     the same as no longer sold. Its stock is visible, issuable, countable,
 *     and correctable, and if that ever stops being true the shop's remaining
 *     inventory becomes invisible to the system that is supposed to track it.
 *  2. **Archived merchandise holds no stock.** Archiving removes something from
 *     day-to-day operation, which is only honest if there is nothing left on a
 *     shelf to remove it from — so archiving is refused while any stock
 *     remains, and never writes stock off to get itself through.
 *  3. **A quantity reaching zero is not a lifecycle change.** Nothing in this
 *     system discontinues or archives merchandise because it sold out.
 */

const RECORDED_AT = '2026-08-03T12:00:00.000Z';
const OCCURRED_AT = '2026-08-03T10:15:00.000Z';

let db: TestDatabase;
let app: FastifyInstance;
/** Holds every capability, including `catalog.deactivate`. */
let owner: TestSession;
/** Holds `catalog.deactivate` under the default seed. */
let manager: TestSession;
/** Holds `catalog.read` but not `catalog.deactivate`. */
let employee: TestSession;
let locationId: string;

interface Injected {
  status: number;
  body: unknown;
}

function errorCode(responseBody: unknown): string {
  return (responseBody as ErrorBody).error.code;
}

/** Creates merchandise through the real endpoint, so every row is one the catalog wrote. */
async function newProduct(name: string, variantCount = 1): Promise<Product> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/catalog/products',
    cookies: owner.cookies,
    payload: {
      name,
      variants: Array.from({ length: variantCount }, (_unused, index) => ({
        attributes: { size: String(38 + index) },
      })),
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return createProductResponseSchema.parse(response.json());
}

async function setProductLifecycle(
  productId: string,
  lifecycleStatus: LifecycleStatus,
  session: TestSession = owner,
): Promise<Injected> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/catalog/products/${productId}/lifecycle`,
    cookies: session.cookies,
    payload: { lifecycleStatus },
  });
  return { status: response.statusCode, body: response.json() };
}

async function setVariantLifecycle(
  variantId: string,
  lifecycleStatus: LifecycleStatus,
  session: TestSession = owner,
): Promise<Injected> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/catalog/variants/${variantId}/lifecycle`,
    cookies: session.cookies,
    payload: { lifecycleStatus },
  });
  return { status: response.statusCode, body: response.json() };
}

async function setProductOk(productId: string, lifecycleStatus: LifecycleStatus): Promise<Product> {
  const { status, body } = await setProductLifecycle(productId, lifecycleStatus);
  expect(status, JSON.stringify(body)).toBe(200);
  return productSchema.parse(body);
}

async function setVariantOk(variantId: string, lifecycleStatus: LifecycleStatus): Promise<void> {
  const { status, body } = await setVariantLifecycle(variantId, lifecycleStatus);
  expect(status, JSON.stringify(body)).toBe(200);
  expect(productVariantSchema.parse(body).lifecycleStatus).toBe(lifecycleStatus);
}

async function receive(variantId: string, quantity: number): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/receive',
    cookies: owner.cookies,
    payload: { operationId: newId(), variantId, locationId, quantity, occurredAt: OCCURRED_AT },
  });
  return { status: response.statusCode, body: response.json() };
}

async function receiveOk(variantId: string, quantity: number): Promise<string> {
  const { status, body } = await receive(variantId, quantity);
  expect(status, JSON.stringify(body)).toBe(201);
  return (body as { movementId: string }).movementId;
}

async function issue(variantId: string, quantity: number): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/remove',
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId,
      locationId,
      quantity,
      reason: 'SOLD',
      occurredAt: OCCURRED_AT,
    },
  });
  return { status: response.statusCode, body: response.json() };
}

async function currentStockIds(): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/inventory/balances',
    cookies: owner.cookies,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { variantId: string }[]).map((entry) => entry.variantId);
}

async function storedLifecycle(variantId: string): Promise<string> {
  const { rows } = await db.pool.query<{ lifecycle_status: string }>(
    `SELECT lifecycle_status FROM product_variants WHERE id = $1`,
    [variantId],
  );
  return rows[0]!.lifecycle_status;
}

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool, { role: 'OWNER' });
  manager = await createTestSession(db.pool, { role: 'MANAGER' });
  employee = await createTestSession(db.pool, { role: 'EMPLOYEE' });
  app = await buildApp({
    config: { ...loadConfig(), LOG_LEVEL: 'silent' },
    pool: db.pool,
    clock: fixedClock(new Date(RECORDED_AT)),
  });

  const locations = await app.inject({
    method: 'GET',
    url: '/api/inventory/locations',
    cookies: owner.cookies,
  });
  locationId = (locations.json() as { id: string; isDefault: boolean }[]).find(
    (location) => location.isDefault,
  )!.id;
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('ACTIVE', () => {
  it('receives, issues, and appears in current stock', async () => {
    const product = await newProduct('Active Merchandise');
    const variantId = product.variants[0]!.id;

    expect(product.lifecycleStatus).toBe('ACTIVE');
    expect(product.variants[0]!.lifecycleStatus).toBe('ACTIVE');

    expect((await receive(variantId, 5)).status).toBe(201);
    expect((await issue(variantId, 2)).status).toBe(201);
    expect(await currentStockIds()).toContain(variantId);
  });
});

describe('DISCONTINUED', () => {
  it('refuses a receipt, allows an issue, and stays in current stock', async () => {
    // The status that a single availability flag could not express, and the
    // reason lifecycle had to replace one. Replenishment stops; trading does
    // not.
    const product = await newProduct('Discontinued Merchandise');
    const variantId = product.variants[0]!.id;
    await receiveOk(variantId, 6);

    await setVariantOk(variantId, 'DISCONTINUED');

    const refused = await receive(variantId, 2);
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorBody).error.message).toContain('DISCONTINUED');

    expect((await issue(variantId, 2)).status).toBe(201);
    expect(await currentStockIds()).toContain(variantId);
  });

  it('keeps its history readable', async () => {
    const product = await newProduct('Discontinued With History');
    const variantId = product.variants[0]!.id;
    const movementId = await receiveOk(variantId, 3);

    await setVariantOk(variantId, 'DISCONTINUED');

    const response = await app.inject({
      method: 'GET',
      url: `/api/inventory/movements?variantId=${variantId}`,
      cookies: owner.cookies,
    });
    const page = movementHistoryPageSchema.parse(response.json());
    expect(page.items.map((item) => item.id)).toEqual([movementId]);
    expect(page.items[0]?.variant.productName).toBe('Discontinued With History');
  });

  it('stays discontinued when its stock reaches zero', async () => {
    // A quantity reaching zero is a fact about a shelf; discontinuing is a
    // decision about merchandise. Nothing here promotes one into the other.
    const product = await newProduct('Sold Out Discontinued');
    const variantId = product.variants[0]!.id;
    await receiveOk(variantId, 2);
    await setVariantOk(variantId, 'DISCONTINUED');

    expect((await issue(variantId, 2)).status).toBe(201);

    expect(await storedLifecycle(variantId)).toBe('DISCONTINUED');
    // Still on the operational list, at zero, because somebody has to be able
    // to see that it is empty.
    expect(await currentStockIds()).toContain(variantId);
  });
});

describe('ARCHIVED', () => {
  it('refuses a receipt and an issue, and leaves the current-stock view', async () => {
    const product = await newProduct('Archived Merchandise');
    const variantId = product.variants[0]!.id;

    await setVariantOk(variantId, 'ARCHIVED');

    expect((await receive(variantId, 1)).status).toBe(409);
    expect((await issue(variantId, 1)).status).toBe(409);
    expect(await currentStockIds()).not.toContain(variantId);
  });

  it('keeps its history readable, which is what archiving is for', async () => {
    const product = await newProduct('Archived With History');
    const variantId = product.variants[0]!.id;
    const receipt = await receiveOk(variantId, 4);
    await issue(variantId, 4);

    await setVariantOk(variantId, 'ARCHIVED');

    const response = await app.inject({
      method: 'GET',
      url: `/api/inventory/movements?variantId=${variantId}`,
      cookies: owner.cookies,
    });
    const page = movementHistoryPageSchema.parse(response.json());
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.id)).toContain(receipt);
    expect(page.items[0]?.variant.sku).toBe(product.variants[0]!.sku);
  });
});

describe('archive safety', () => {
  it('refuses to archive a variant that still holds stock', async () => {
    // The hard business invariant. Archiving something with six units on the
    // shelf would hide inventory the shop owns behind a status that says it is
    // out of operation.
    const product = await newProduct('Stocked Variant');
    const variantId = product.variants[0]!.id;
    await receiveOk(variantId, 6);

    const { status, body } = await setVariantLifecycle(variantId, 'ARCHIVED');
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('CONFLICT');
    expect((body as ErrorBody).error.message).toContain('6 unit');

    // Nothing was archived, and — just as importantly — nothing was written
    // off to make the archive possible.
    expect(await storedLifecycle(variantId)).toBe('ACTIVE');
    expect(await currentStockIds()).toContain(variantId);
  });

  it('archives a variant once its stock is gone', async () => {
    const product = await newProduct('Emptied Variant');
    const variantId = product.variants[0]!.id;
    await receiveOk(variantId, 6);
    expect((await setVariantLifecycle(variantId, 'ARCHIVED')).status).toBe(409);

    await issue(variantId, 6);
    await setVariantOk(variantId, 'ARCHIVED');
    expect(await currentStockIds()).not.toContain(variantId);
  });

  it('refuses to archive a product when any one of its variants holds stock', async () => {
    // Checked across every variant, in one bulk read rather than a query per
    // SKU, and a single stocked sibling is enough to refuse.
    const product = await newProduct('Partly Stocked Product', 3);
    const [first, second, third] = product.variants;
    await receiveOk(third!.id, 2);

    const { status, body } = await setProductLifecycle(product.id, 'ARCHIVED');
    expect(status).toBe(409);
    expect((body as ErrorBody).error.message).toContain('1 variant');

    expect(await storedLifecycle(first!.id)).toBe('ACTIVE');
    expect(await storedLifecycle(second!.id)).toBe('ACTIVE');
  });

  it('archives a product when every variant is empty', async () => {
    const product = await newProduct('Empty Product', 2);
    const archived = await setProductOk(product.id, 'ARCHIVED');
    expect(archived.lifecycleStatus).toBe('ARCHIVED');

    for (const variant of product.variants) {
      expect(await currentStockIds()).not.toContain(variant.id);
      // Child rows are not mass-updated: the effective rule already governs
      // them, and rewriting their status would erase what restoring the product
      // is supposed to restore.
      expect(await storedLifecycle(variant.id)).toBe('ACTIVE');
    }
  });

  it('does not consult the current-stock list, but the balance projection', async () => {
    // A variant whose product is already discontinued is still on the
    // operational list; one whose product is archived is not. Neither is the
    // authority on whether stock exists — `inventory_balances` is — and an
    // archive check reading a filtered view would archive merchandise that the
    // view had already hidden for an unrelated reason.
    const product = await newProduct('Discontinued Then Archived');
    const variantId = product.variants[0]!.id;
    await receiveOk(variantId, 3);
    await setProductOk(product.id, 'DISCONTINUED');

    expect((await setProductLifecycle(product.id, 'ARCHIVED')).status).toBe(409);
  });

  it('allows DISCONTINUED with stock on the shelf', async () => {
    // Only archiving requires zero stock. Discontinuing merchandise the shop is
    // still selling down is the ordinary case and must not be blocked.
    const product = await newProduct('Discontinued With Stock');
    const variantId = product.variants[0]!.id;
    await receiveOk(variantId, 9);

    await setVariantOk(variantId, 'DISCONTINUED');
    expect(await currentStockIds()).toContain(variantId);
  });
});

describe('the transition matrix', () => {
  it('walks the forward path ACTIVE → DISCONTINUED → ARCHIVED', async () => {
    const product = await newProduct('Forward Path');
    await setProductOk(product.id, 'DISCONTINUED');
    const archived = await setProductOk(product.id, 'ARCHIVED');
    expect(archived.lifecycleStatus).toBe('ARCHIVED');
  });

  it('allows ACTIVE → ARCHIVED directly, for merchandise entered by mistake', async () => {
    const product = await newProduct('Entered By Mistake');
    expect((await setProductOk(product.id, 'ARCHIVED')).lifecycleStatus).toBe('ARCHIVED');
  });

  it('restores DISCONTINUED → ACTIVE', async () => {
    // A system whose only correction path is a database session does not have a
    // correction path.
    const product = await newProduct('Resumed');
    await setProductOk(product.id, 'DISCONTINUED');
    const restored = await setProductOk(product.id, 'ACTIVE');
    expect(restored.lifecycleStatus).toBe('ACTIVE');

    expect((await receive(product.variants[0]!.id, 1)).status).toBe(201);
  });

  it('restores ARCHIVED → DISCONTINUED', async () => {
    const product = await newProduct('Unarchived');
    await setProductOk(product.id, 'ARCHIVED');
    const restored = await setProductOk(product.id, 'DISCONTINUED');
    expect(restored.lifecycleStatus).toBe('DISCONTINUED');
    // Back in day-to-day operation: issuable and visible again, but still not
    // replenished, because being reordered is a separate decision.
    expect(await currentStockIds()).toContain(product.variants[0]!.id);
    expect((await receive(product.variants[0]!.id, 1)).status).toBe(409);
  });

  it('refuses ARCHIVED → ACTIVE, and names what is permitted instead', async () => {
    // Two deliberate steps rather than one click that answers two questions:
    // whether it is back in operation, and whether it is being bought again.
    const product = await newProduct('Straight Back');
    await setProductOk(product.id, 'ARCHIVED');

    const { status, body } = await setProductLifecycle(product.id, 'ACTIVE');
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('CONFLICT');
    expect((body as ErrorBody).error.message).toContain('DISCONTINUED');
  });

  it('treats a repeat of the current status as a no-op', async () => {
    // A declarative PATCH restating what is already true has nothing to do and
    // no reason to fail — two people pressing the same button agree.
    const product = await newProduct('Idempotent');
    const first = await setProductOk(product.id, 'DISCONTINUED');
    const again = await setProductOk(product.id, 'DISCONTINUED');
    expect(again.lifecycleStatus).toBe('DISCONTINUED');
    // Not even the timestamp moves: nothing changed.
    expect(again.updatedAt).toBe(first.updatedAt);
  });

  it('refuses a status outside the vocabulary, and a body naming anything else', async () => {
    const product = await newProduct('Strict Contract');

    for (const payload of [
      { lifecycleStatus: 'RETIRED' },
      { lifecycleStatus: 'ACTIVE', isActive: false },
      { lifecycleStatus: 'ACTIVE', productId: product.id },
      { lifecycleStatus: 'ACTIVE', updatedAt: RECORDED_AT },
      { isActive: false },
      {},
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/catalog/products/${product.id}/lifecycle`,
        cookies: owner.cookies,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('answers 404 for merchandise that does not exist, and 400 for a malformed id', async () => {
    expect((await setProductLifecycle(newId(), 'DISCONTINUED')).status).toBe(404);
    expect((await setVariantLifecycle(newId(), 'DISCONTINUED')).status).toBe(404);

    const malformed = await app.inject({
      method: 'PATCH',
      url: '/api/catalog/products/not-a-uuid/lifecycle',
      cookies: owner.cookies,
      payload: { lifecycleStatus: 'DISCONTINUED' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('publishes exactly the statuses the database accepts', async () => {
    const { rows } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'product_variants_lifecycle_status_known'`,
    );
    for (const status of LIFECYCLE_STATUSES) expect(rows[0]?.def).toContain(`'${status}'`);
    expect(rows[0]?.def.match(/'[A-Z_]+'/g)?.length).toBe(LIFECYCLE_STATUSES.length);
  });
});

describe('effective status: product and variant combined', () => {
  it('makes an ACTIVE variant of a DISCONTINUED product unreceivable but issuable', async () => {
    const product = await newProduct('Discontinued Parent');
    const variantId = product.variants[0]!.id;
    await receiveOk(variantId, 5);

    await setProductOk(product.id, 'DISCONTINUED');

    expect(await storedLifecycle(variantId)).toBe('ACTIVE');
    expect((await receive(variantId, 1)).status).toBe(409);
    expect((await issue(variantId, 1)).status).toBe(201);
    expect(await currentStockIds()).toContain(variantId);
  });

  it('makes an ACTIVE variant of an ARCHIVED product effectively archived', async () => {
    const product = await newProduct('Archived Parent');
    const variantId = product.variants[0]!.id;

    await setProductOk(product.id, 'ARCHIVED');

    expect(await storedLifecycle(variantId)).toBe('ACTIVE');
    expect((await receive(variantId, 1)).status).toBe(409);
    expect((await issue(variantId, 1)).status).toBe(409);
    expect(await currentStockIds()).not.toContain(variantId);
  });

  it('leaves sibling variants alone when one is discontinued', async () => {
    const product = await newProduct('Two Colours', 2);
    const [withdrawn, sibling] = product.variants;
    await receiveOk(withdrawn!.id, 2);
    await receiveOk(sibling!.id, 2);

    await setVariantOk(withdrawn!.id, 'DISCONTINUED');

    expect((await receive(withdrawn!.id, 1)).status).toBe(409);
    expect((await receive(sibling!.id, 1)).status).toBe(201);
    expect(await storedLifecycle(sibling!.id)).toBe('ACTIVE');
  });

  it('restores a product without resurrecting a variant discontinued on its own', async () => {
    // The reason effective status is derived rather than propagated. If
    // withdrawing the product had rewritten its variants' rows, restoring it
    // could not know which of them the shop had already withdrawn separately.
    const product = await newProduct('Restored Parent', 2);
    const [ownWithdrawal, other] = product.variants;
    await setVariantOk(ownWithdrawal!.id, 'DISCONTINUED');
    await setProductOk(product.id, 'DISCONTINUED');

    await setProductOk(product.id, 'ACTIVE');

    // The one the shop discontinued deliberately is still discontinued.
    expect((await receive(ownWithdrawal!.id, 1)).status).toBe(409);
    // And the one that was only covered by the product is available again.
    expect((await receive(other!.id, 1)).status).toBe(201);
  });
});

describe('replay after a lifecycle change', () => {
  it('answers a receipt posted while the merchandise was ACTIVE', async () => {
    // A settled command is a fact about the past, and lifecycle becoming
    // authoritative must not make one unanswerable. Without this, a client that
    // never saw the first response would retry forever into a 409 — for stock
    // that is already on the shelf.
    const product = await newProduct('Retried After Withdrawal');
    const variantId = product.variants[0]!.id;

    const request = {
      operationId: newId(),
      variantId,
      locationId,
      quantity: 4,
      occurredAt: OCCURRED_AT,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/inventory/receive',
      cookies: owner.cookies,
      payload: request,
    });
    expect(first.statusCode).toBe(201);

    await setVariantOk(variantId, 'DISCONTINUED');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/inventory/receive',
      cookies: owner.cookies,
      payload: request,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const { rows } = await db.pool.query(
      `SELECT 1 FROM inventory_movements WHERE variant_id = $1`,
      [variantId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const product = await newProduct('Anonymous Attempt');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/catalog/products/${product.id}/lifecycle`,
      payload: { lifecycleStatus: 'DISCONTINUED' },
    });
    expect(response.statusCode).toBe(401);
    expect(await storedLifecycle(product.variants[0]!.id)).toBe('ACTIVE');
  });

  it('refuses an employee, who may read the catalog but not withdraw merchandise', async () => {
    const product = await newProduct('Employee Attempt');

    const refusedProduct = await setProductLifecycle(product.id, 'DISCONTINUED', employee);
    expect(refusedProduct.status).toBe(403);
    expect(errorCode(refusedProduct.body)).toBe('FORBIDDEN');

    const refusedVariant = await setVariantLifecycle(
      product.variants[0]!.id,
      'DISCONTINUED',
      employee,
    );
    expect(refusedVariant.status).toBe(403);

    const stillActive = await app.inject({
      method: 'GET',
      url: '/api/catalog/products',
      cookies: employee.cookies,
    });
    expect(stillActive.statusCode).toBe(200);
  });

  it('allows a manager', async () => {
    const product = await newProduct('Manager Attempt');
    const { status } = await setProductLifecycle(product.id, 'DISCONTINUED', manager);
    expect(status).toBe(200);
  });
});
