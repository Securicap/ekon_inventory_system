import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorBodySchema,
  listInventoryBalancesResponseSchema,
  type VariantStockBalance,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import type { InventoryService, ReceivingService } from '../../src/modules/inventory/index.js';
import { registerInventoryRoutes } from '../../src/modules/inventory/routes.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `GET /api/inventory/balances`, end to end, against real PostgreSQL.
 *
 * This endpoint answers one question — *what do we have, and where?* — and the
 * assertions here are mostly about the two ways an answer like that goes wrong.
 *
 * The first is **omission**. A variant nobody has ever booked stock in against
 * has no `inventory_balances` row, and a read that starts from that table would
 * quietly leave it out. It is precisely the item somebody is hunting for when
 * they ask why the shelf is empty, so several tests below exist only to prove it
 * comes back, with a zero, at every active location.
 *
 * The second is **writing during a read**. Filling those gaps by inserting zero
 * rows would be a write inside a GET and would stamp an `updated_at` on a moment
 * at which nothing happened. So the tests count rows before and after.
 *
 * Stock is created through the real receiving endpoint and therefore the real
 * posting engine — never by writing `inventory_balances` directly — so what is
 * read back is a projection this system actually maintained.
 */

/** Server time, from the injected clock. Every balance row is stamped with it. */
const RECORDED_AT = '2026-08-03T12:00:00.000Z';
/** Business time: the delivery arrived before it was entered. */
const OCCURRED_AT = '2026-08-03T08:30:00.000Z';

const BALANCES = '/api/inventory/balances';
const SEEDED_LOCATION = 'Main Store';

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-B${skuCounter.toString().padStart(7, '0')}`;
}

interface Variant {
  productId: string;
  variantId: string;
  sku: string;
}

interface ProductOptions {
  name?: string;
  sku?: string;
  attributes?: Record<string, string>;
  productActive?: boolean;
  variantActive?: boolean;
}

/**
 * A product with one variant, written straight to the catalog tables.
 *
 * Direct SQL rather than `POST /api/catalog/products` because these tests need
 * states no production path can currently produce: a retired product, a retired
 * variant. Nothing in `src/` can deactivate either yet, and the read has to be
 * correct on the day that lands. One test below does go through the real catalog
 * endpoint, to prove the composition works on rows the catalog itself wrote.
 */
async function newProduct(db: TestDatabase, options: ProductOptions = {}): Promise<Variant> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [productId, options.name ?? 'Stock fixture', options.productActive ?? true, RECORDED_AT],
  );

  const variant = await newVariantOf(db, productId, options);
  return { productId, ...variant };
}

/** A second (or third) variant of a product that already exists. */
async function newVariantOf(
  db: TestDatabase,
  productId: string,
  options: Pick<ProductOptions, 'sku' | 'attributes' | 'variantActive'> = {},
): Promise<{ productId: string; variantId: string; sku: string }> {
  const variantId = newId();
  const sku = options.sku ?? nextSku();
  const attributes = Object.entries(options.attributes ?? {});

  await db.pool.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [variantId, productId, sku, sku, options.variantActive ?? true, RECORDED_AT],
  );

  for (const [name, value] of attributes) {
    await db.pool.query(
      `INSERT INTO variant_attributes (variant_id, attribute_name, attribute_value)
       VALUES ($1, $2, $3)`,
      [variantId, name, value],
    );
  }

  return { productId, variantId, sku };
}

/** A place stock can sit, beside the one the migration seeds. */
async function newLocation(
  db: TestDatabase,
  name: string,
  options: { isActive?: boolean } = {},
): Promise<string> {
  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, $2, false, $3, $4, $4)`,
    [locationId, name, options.isActive ?? true, RECORDED_AT],
  );
  return locationId;
}

/** The id of the seeded default location, discovered rather than hard-coded. */
async function defaultLocationId(db: TestDatabase): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM inventory_locations WHERE is_default`,
  );
  return rows[0]!.id;
}

describe('current stock', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  /** Holds every capability. These tests are about the answer, not about access. */
  let owner: TestSession;

  let mainStoreId: string;
  let backroomId: string;

  /** Books stock in through the real receiving endpoint and the real ledger. */
  async function receive(variantId: string, locationId: string, quantity: number): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/inventory/receive',
      headers: { 'content-type': 'application/json' },
      cookies: owner.cookies,
      payload: JSON.stringify({
        operationId: newId(),
        variantId,
        locationId,
        quantity,
        occurredAt: OCCURRED_AT,
      }),
    });
    expect(response.statusCode, response.payload).toBe(201);
  }

  /** The whole response, parsed through the shared contract. */
  async function stock(session: TestSession = owner): Promise<VariantStockBalance[]> {
    const response = await app.inject({ method: 'GET', url: BALANCES, cookies: session.cookies });
    expect(response.statusCode, response.payload).toBe(200);
    return listInventoryBalancesResponseSchema.parse(response.json());
  }

  /** One variant's entry, or `undefined` when it was not returned at all. */
  async function stockFor(variantId: string): Promise<VariantStockBalance | undefined> {
    return (await stock()).find((entry) => entry.variantId === variantId);
  }

  async function countRows(table: string): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`,
    );
    return Number(rows[0]!.count);
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    owner = await createTestSession(db.pool);
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent' },
      pool: db.pool,
      clock: fixedClock(new Date(RECORDED_AT)),
    });

    mainStoreId = await defaultLocationId(db);
    backroomId = await newLocation(db, 'Backroom');
    // Closed, and therefore never part of an operational stock view.
    await newLocation(db, 'Closed Kiosk', { isActive: false });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  describe('a variant nobody has ever booked stock in against', () => {
    it('is returned, at zero, for every active location, with no timestamp', async () => {
      const variant = await newProduct(db, { name: 'Never Stocked' });

      const entry = await stockFor(variant.variantId);
      expect(entry).toBeDefined();
      expect(entry?.productName).toBe('Never Stocked');
      expect(entry?.sku).toBe(variant.sku);
      expect(entry?.totalQuantity).toBe(0);

      // Every active location, and only the active ones.
      expect(entry?.locations.map((location) => location.locationName)).toEqual([
        SEEDED_LOCATION,
        'Backroom',
      ]);
      for (const location of entry?.locations ?? []) {
        expect(location.quantity).toBe(0);
        // No balance row exists, so there is no moment at which this changed.
        expect(location.updatedAt).toBeNull();
      }
    });

    it('is still absent from inventory_balances afterwards', async () => {
      // The completeness above is composed in the response, not manufactured in
      // the database. A GET that created rows to answer itself would be a write
      // in a read, and would invent an `updated_at`.
      const variant = await newProduct(db, { name: 'Still Never Stocked' });

      const balancesBefore = await countRows('inventory_balances');
      const movementsBefore = await countRows('inventory_movements');
      const operationsBefore = await countRows('operations');

      await stock();
      await stock();

      expect(await countRows('inventory_balances')).toBe(balancesBefore);
      expect(await countRows('inventory_movements')).toBe(movementsBefore);
      expect(await countRows('operations')).toBe(operationsBefore);

      const { rows } = await db.pool.query(
        `SELECT 1 FROM inventory_balances WHERE variant_id = $1`,
        [variant.variantId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('a variant that holds stock', () => {
    it('reports the quantity the projection holds, and when it moved', async () => {
      const variant = await newProduct(db, { name: 'Bottled Water' });
      await receive(variant.variantId, mainStoreId, 7);

      const entry = await stockFor(variant.variantId);
      expect(entry?.totalQuantity).toBe(7);

      const mainStore = entry?.locations.find((location) => location.locationId === mainStoreId);
      expect(mainStore?.quantity).toBe(7);
      expect(mainStore?.isDefault).toBe(true);
      // The balance row's own timestamp, which the posting engine took from the
      // server clock — not the product's, the location's, or "now".
      expect(mainStore?.updatedAt).toBe(RECORDED_AT);

      // And it is the projection that was read, not a number this test guessed.
      const { rows } = await db.pool.query<{ quantity_on_hand: number; updated_at: Date }>(
        `SELECT quantity_on_hand, updated_at FROM inventory_balances
          WHERE variant_id = $1 AND location_id = $2`,
        [variant.variantId, mainStoreId],
      );
      expect(rows[0]?.quantity_on_hand).toBe(mainStore?.quantity);
      expect(rows[0]?.updated_at.toISOString()).toBe(mainStore?.updatedAt);
    });

    it('accumulates several receipts into one current quantity', async () => {
      const variant = await newProduct(db, { name: 'Accumulating Item' });
      await receive(variant.variantId, mainStoreId, 4);
      await receive(variant.variantId, mainStoreId, 6);

      const entry = await stockFor(variant.variantId);
      expect(entry?.totalQuantity).toBe(10);
      expect(entry?.locations.find((l) => l.locationId === mainStoreId)?.quantity).toBe(10);
    });

    it('carries no movement history, no chain pointers, and nobody’s user id', async () => {
      const variant = await newProduct(db, { name: 'No Leaks' });
      await receive(variant.variantId, mainStoreId, 3);

      const entry = await stockFor(variant.variantId);
      expect(Object.keys(entry ?? {}).sort()).toEqual([
        'attributes',
        'locations',
        'productId',
        'productName',
        'sku',
        'totalQuantity',
        'variantId',
      ]);
      expect(Object.keys(entry?.locations[0] ?? {}).sort()).toEqual([
        'isDefault',
        'locationId',
        'locationName',
        'quantity',
        'updatedAt',
      ]);

      // Nothing from the ledger reached the wire, under any name.
      const response = await app.inject({ method: 'GET', url: BALANCES, cookies: owner.cookies });
      const payload = response.payload.toLowerCase();
      for (const leaked of [
        'movement',
        'operation',
        'signature',
        'userid',
        'requesthash',
        'quantitybefore',
        'quantityafter',
        'recordedat',
        'occurredat',
        owner.user.id.toLowerCase(),
      ]) {
        expect(payload, `leaked "${leaked}"`).not.toContain(leaked);
      }
    });
  });

  describe('a balance row that has been drawn back down to zero', () => {
    it('reports zero with the real timestamp, not a null', async () => {
      // No workflow removes stock yet, so the state is written directly: a shelf
      // whose compensating movements brought it back to zero keeps its row, and
      // therefore keeps a real moment at which it last changed. That is what
      // distinguishes it from a shelf that has never held anything.
      const variant = await newProduct(db, { name: 'Emptied Shelf' });
      const emptiedAt = '2026-08-02T09:15:00.000Z';
      await db.pool.query(
        `INSERT INTO inventory_balances
           (variant_id, location_id, quantity_on_hand, last_movement_id, updated_at)
         VALUES ($1, $2, 0, NULL, $3)`,
        [variant.variantId, mainStoreId, emptiedAt],
      );

      const entry = await stockFor(variant.variantId);
      const mainStore = entry?.locations.find((location) => location.locationId === mainStoreId);
      expect(mainStore?.quantity).toBe(0);
      expect(mainStore?.updatedAt).toBe(emptiedAt);

      // The other shelf has no row at all, and is the other kind of zero.
      const backroom = entry?.locations.find((location) => location.locationId === backroomId);
      expect(backroom?.quantity).toBe(0);
      expect(backroom?.updatedAt).toBeNull();

      expect(entry?.totalQuantity).toBe(0);
    });
  });

  describe('one variant across several locations', () => {
    it('reports each location separately and totals exactly those numbers', async () => {
      const variant = await newProduct(db, { name: 'Split Across Shelves' });
      await receive(variant.variantId, mainStoreId, 5);
      await receive(variant.variantId, backroomId, 12);

      const entry = await stockFor(variant.variantId);
      expect(entry?.locations.find((l) => l.locationId === mainStoreId)?.quantity).toBe(5);
      expect(entry?.locations.find((l) => l.locationId === backroomId)?.quantity).toBe(12);
      expect(entry?.totalQuantity).toBe(17);
    });

    it('leaves a location that was never stocked at zero, beside one that was', async () => {
      const variant = await newProduct(db, { name: 'One Shelf Only' });
      await receive(variant.variantId, backroomId, 9);

      const entry = await stockFor(variant.variantId);
      const mainStore = entry?.locations.find((l) => l.locationId === mainStoreId);
      expect(mainStore?.quantity).toBe(0);
      expect(mainStore?.updatedAt).toBeNull();
      expect(entry?.locations.find((l) => l.locationId === backroomId)?.quantity).toBe(9);
      expect(entry?.totalQuantity).toBe(9);
    });
  });

  describe('several variants and several products', () => {
    it('keeps every quantity attached to the variant and location it belongs to', async () => {
      const shirt = await newProduct(db, {
        name: 'Work Shirt',
        attributes: { size: 'M' },
      });
      const largeShirt = await newVariantOf(db, shirt.productId, { attributes: { size: 'L' } });
      const rope = await newProduct(db, { name: 'Anchor Rope' });

      await receive(shirt.variantId, mainStoreId, 2);
      await receive(largeShirt.variantId, mainStoreId, 3);
      await receive(largeShirt.variantId, backroomId, 4);
      await receive(rope.variantId, backroomId, 11);

      const all = await stock();
      const find = (variantId: string): VariantStockBalance | undefined =>
        all.find((entry) => entry.variantId === variantId);

      // Two variants of one product, each with its own numbers and attributes.
      expect(find(shirt.variantId)?.attributes).toEqual([{ name: 'size', value: 'M' }]);
      expect(find(shirt.variantId)?.totalQuantity).toBe(2);
      expect(find(largeShirt.variantId)?.attributes).toEqual([{ name: 'size', value: 'L' }]);
      expect(find(largeShirt.variantId)?.totalQuantity).toBe(7);
      expect(find(largeShirt.variantId)?.productId).toBe(shirt.productId);

      // And a different product entirely.
      expect(find(rope.variantId)?.totalQuantity).toBe(11);
      expect(
        find(rope.variantId)?.locations.find((l) => l.locationId === mainStoreId)?.quantity,
      ).toBe(0);
      expect(
        find(rope.variantId)?.locations.find((l) => l.locationId === backroomId)?.quantity,
      ).toBe(11);
    });

    it('totals every returned variant from its own location entries', async () => {
      // The invariant that makes the total trustworthy: it is the sum of what is
      // beside it, for every row in the answer, not only the ones set up above.
      const all = await stock();
      expect(all.length).toBeGreaterThan(0);
      for (const entry of all) {
        expect(entry.totalQuantity, `${entry.productName} / ${entry.sku}`).toBe(
          entry.locations.reduce((sum, location) => sum + location.quantity, 0),
        );
      }
    });
  });

  describe('what an operational view leaves out', () => {
    it('omits a retired variant, and keeps its ledger history', async () => {
      const variant = await newProduct(db, { name: 'Retired Variant Product' });
      await receive(variant.variantId, mainStoreId, 6);
      expect(await stockFor(variant.variantId)).toBeDefined();

      await db.pool.query(`UPDATE product_variants SET is_active = false WHERE id = $1`, [
        variant.variantId,
      ]);

      expect(await stockFor(variant.variantId)).toBeUndefined();

      // Excluded from a present-tense view, not erased. The movement and the
      // balance are exactly as they were.
      const { rows: movements } = await db.pool.query(
        `SELECT 1 FROM inventory_movements WHERE variant_id = $1`,
        [variant.variantId],
      );
      expect(movements).toHaveLength(1);
      const { rows: balances } = await db.pool.query<{ quantity_on_hand: number }>(
        `SELECT quantity_on_hand FROM inventory_balances WHERE variant_id = $1`,
        [variant.variantId],
      );
      expect(balances[0]?.quantity_on_hand).toBe(6);
    });

    it('omits every variant of a retired product, active or not', async () => {
      // A variant nobody deactivated, under a product that was withdrawn, is
      // not something the business sells today.
      const product = await newProduct(db, { name: 'Withdrawn Product' });
      const second = await newVariantOf(db, product.productId, {});
      await receive(product.variantId, mainStoreId, 4);

      await db.pool.query(`UPDATE products SET is_active = false WHERE id = $1`, [
        product.productId,
      ]);

      expect(await stockFor(product.variantId)).toBeUndefined();
      expect(await stockFor(second.variantId)).toBeUndefined();
    });

    it('omits a closed location from every variant', async () => {
      const closed = await newLocation(db, 'Later Closed', { isActive: true });
      const variant = await newProduct(db, { name: 'Location Closes Under It' });
      await receive(variant.variantId, closed, 8);

      const before = await stockFor(variant.variantId);
      expect(before?.locations.find((l) => l.locationId === closed)?.quantity).toBe(8);
      expect(before?.totalQuantity).toBe(8);

      await db.pool.query(`UPDATE inventory_locations SET is_active = false WHERE id = $1`, [
        closed,
      ]);

      const after = await stock();
      for (const entry of after) {
        expect(entry.locations.map((l) => l.locationId)).not.toContain(closed);
      }
      // The stock is still on that shelf in the ledger; it is simply not part of
      // an operational view, and so not part of the totals either.
      const entry = after.find((e) => e.variantId === variant.variantId);
      expect(entry?.totalQuantity).toBe(0);
      const { rows } = await db.pool.query<{ quantity_on_hand: number }>(
        `SELECT quantity_on_hand FROM inventory_balances
          WHERE variant_id = $1 AND location_id = $2`,
        [variant.variantId, closed],
      );
      expect(rows[0]?.quantity_on_hand).toBe(8);
    });
  });

  describe('ordering', () => {
    it('orders variants by product name, then SKU, then id', async () => {
      const zinc = await newProduct(db, { name: 'Zzz Last Product', sku: 'EKN-Z0000001' });
      const anchorProduct = await newProduct(db, {
        name: 'Aaa First Product',
        sku: 'EKN-Z0000002',
      });
      // A second variant of the first product, created later but sorting first
      // by SKU — so insertion order cannot be what produced the answer.
      const anchorSecond = await newVariantOf(db, anchorProduct.productId, {
        sku: 'EKN-A0000003',
      });

      const all = await stock();
      const positions = [zinc.variantId, anchorProduct.variantId, anchorSecond.variantId].map(
        (variantId) => all.findIndex((entry) => entry.variantId === variantId),
      );
      const [zincAt, anchorFirstAt, anchorSecondAt] = positions;

      expect(positions.every((index) => index >= 0)).toBe(true);
      // Product name first: both variants of "Aaa" precede "Zzz".
      expect(anchorSecondAt).toBeLessThan(zincAt!);
      expect(anchorFirstAt).toBeLessThan(zincAt!);
      // Then SKU, within the product.
      expect(anchorSecondAt).toBeLessThan(anchorFirstAt!);
    });

    it('is stable across the whole answer, not only the rows a test set up', async () => {
      const all = await stock();
      const keys = all.map((entry) => [entry.productName, entry.sku, entry.variantId] as const);
      const sorted = [...keys].sort((a, b) => {
        if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
        if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
        return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
      });
      expect(keys).toEqual(sorted);
    });

    it('puts the default location first, then the rest by name', async () => {
      // 'Backroom' sorts before 'Main Store' alphabetically, so the default
      // being first is a rule and not an accident of the names.
      const aisle = await newLocation(db, 'Aisle Two');
      const variant = await newProduct(db, { name: 'Ordering Across Shelves' });

      const entry = await stockFor(variant.variantId);
      expect(entry?.locations[0]?.locationName).toBe(SEEDED_LOCATION);
      expect(entry?.locations[0]?.isDefault).toBe(true);
      expect(entry?.locations.map((location) => location.locationName)).toEqual([
        SEEDED_LOCATION,
        'Aisle Two',
        'Backroom',
      ]);
      expect(entry?.locations.filter((location) => location.isDefault)).toHaveLength(1);

      // Same order for every variant in the answer, not just this one.
      const all = await stock();
      const names = entry!.locations.map((location) => location.locationName);
      for (const other of all) {
        expect(other.locations.map((location) => location.locationName)).toEqual(names);
      }

      await db.pool.query(`UPDATE inventory_locations SET is_active = false WHERE id = $1`, [
        aisle,
      ]);
    });
  });

  describe('the projection is what is read', () => {
    it('reports the balance row even when it disagrees with the movements', async () => {
      // `quantity_on_hand` is the authoritative current-stock projection, and
      // this endpoint reads it — it does not re-derive stock by summing the
      // ledger. Forcing the two apart is the only way to tell those two
      // implementations from each other, since normally they agree.
      const variant = await newProduct(db, { name: 'Projection Wins' });
      await receive(variant.variantId, mainStoreId, 4);
      await receive(variant.variantId, mainStoreId, 6);

      await db.pool.query(
        `UPDATE inventory_balances SET quantity_on_hand = 99
          WHERE variant_id = $1 AND location_id = $2`,
        [variant.variantId, mainStoreId],
      );

      const entry = await stockFor(variant.variantId);
      expect(entry?.locations.find((l) => l.locationId === mainStoreId)?.quantity).toBe(99);
      expect(entry?.totalQuantity).toBe(99);

      // The ledger still says 10, and was neither read nor touched.
      const { rows } = await db.pool.query<{ sum: string }>(
        `SELECT coalesce(sum(quantity_delta), 0)::text AS sum FROM inventory_movements
          WHERE variant_id = $1 AND location_id = $2`,
        [variant.variantId, mainStoreId],
      );
      expect(Number(rows[0]!.sum)).toBe(10);

      await db.pool.query(
        `UPDATE inventory_balances SET quantity_on_hand = 10
          WHERE variant_id = $1 AND location_id = $2`,
        [variant.variantId, mainStoreId],
      );
    });
  });

  describe('a product created through the catalog itself', () => {
    it('appears with the SKU and the attribute order the catalog produced', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/catalog/products',
        headers: { 'content-type': 'application/json' },
        cookies: owner.cookies,
        payload: JSON.stringify({
          name: 'Running Shoe',
          variants: [{ attributes: { Size: '9', color: ' White ' } }],
        }),
      });
      expect(created.statusCode, created.payload).toBe(201);
      const product = created.json() as {
        id: string;
        variants: { id: string; sku: string; attributes: { name: string; value: string }[] }[];
      };
      const variant = product.variants[0]!;

      const entry = await stockFor(variant.id);
      expect(entry?.productId).toBe(product.id);
      expect(entry?.sku).toBe(variant.sku);
      // Normalized and ordered by the catalog, passed through unchanged: names
      // lower-cased, values trimmed with their case kept, sorted by name.
      expect(entry?.attributes).toEqual([
        { name: 'color', value: 'White' },
        { name: 'size', value: '9' },
      ]);
      expect(entry?.attributes).toEqual(variant.attributes);
      expect(entry?.totalQuantity).toBe(0);
    });
  });

  describe('who may read stock', () => {
    it('refuses an anonymous request with 401', async () => {
      const response = await app.inject({ method: 'GET', url: BALANCES });
      expect(response.statusCode).toBe(401);
      expect(errorBodySchema.parse(response.json()).error.code).toBe('UNAUTHENTICATED');
    });

    it('answers a signed-in person who holds inventory.read', async () => {
      // An employee is the lowest role in the system and reads stock all day.
      const employee = await createTestSession(db.pool, {
        role: 'EMPLOYEE',
        username: 'stock.employee',
      });
      const response = await app.inject({
        method: 'GET',
        url: BALANCES,
        cookies: employee.cookies,
      });
      expect(response.statusCode).toBe(200);
      expect(() => listInventoryBalancesResponseSchema.parse(response.json())).not.toThrow();
    });

    it('refuses a signed-in person without the capability, without signing them out', async () => {
      const employee = await createTestSession(db.pool, {
        role: 'EMPLOYEE',
        username: 'denied.employee',
      });
      await db.pool.query(
        `DELETE FROM role_capabilities WHERE role = 'EMPLOYEE' AND capability = 'inventory.read'`,
      );

      const refused = await app.inject({
        method: 'GET',
        url: BALANCES,
        cookies: employee.cookies,
      });
      expect(refused.statusCode).toBe(403);
      expect(errorBodySchema.parse(refused.json()).error.code).toBe('FORBIDDEN');
      // A denial is not a session problem: nothing clears the cookie, and the
      // same session still reaches everything else it may.
      expect(refused.headers['set-cookie']).toBeUndefined();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/catalog/products',
            cookies: employee.cookies,
          })
        ).statusCode,
      ).toBe(200);

      await db.pool.query(
        `INSERT INTO role_capabilities (role, capability) VALUES ('EMPLOYEE', 'inventory.read')`,
      );
      expect(
        (await app.inject({ method: 'GET', url: BALANCES, cookies: employee.cookies })).statusCode,
      ).toBe(200);
    });

    it('decides on the capability alone, never on the role', async () => {
      // An owner holds every capability, so if access were decided by role this
      // would stay 200. Taking the grant away is what changes the answer.
      expect(
        (await app.inject({ method: 'GET', url: BALANCES, cookies: owner.cookies })).statusCode,
      ).toBe(200);

      await db.pool.query(
        `DELETE FROM role_capabilities WHERE role = 'OWNER' AND capability = 'inventory.read'`,
      );
      const refused = await app.inject({ method: 'GET', url: BALANCES, cookies: owner.cookies });
      expect(refused.statusCode).toBe(403);
      expect(errorBodySchema.parse(refused.json()).error.code).toBe('FORBIDDEN');

      await db.pool.query(
        `INSERT INTO role_capabilities (role, capability) VALUES ('OWNER', 'inventory.read')`,
      );
      expect(
        (await app.inject({ method: 'GET', url: BALANCES, cookies: owner.cookies })).statusCode,
      ).toBe(200);
    });
  });
});

describe('a business with nothing in its catalog', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let owner: TestSession;

  beforeAll(async () => {
    db = await createTestDatabase();
    owner = await createTestSession(db.pool);
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent' },
      pool: db.pool,
      clock: fixedClock(new Date(RECORDED_AT)),
    });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('answers 200 with an empty array', async () => {
    // A fresh install has the seeded default location and no products at all.
    // "We stock nothing" is an answer, not a missing resource and not an error.
    const response = await app.inject({ method: 'GET', url: BALANCES, cookies: owner.cookies });
    expect(response.statusCode).toBe(200);
    expect(listInventoryBalancesResponseSchema.parse(response.json())).toEqual([]);
  });

  it('answers an empty array when every product has been retired', async () => {
    await newProduct(db, { name: 'Discontinued', productActive: false });
    await newProduct(db, { name: 'Also Discontinued', variantActive: false });

    const response = await app.inject({ method: 'GET', url: BALANCES, cookies: owner.cookies });
    expect(listInventoryBalancesResponseSchema.parse(response.json())).toEqual([]);
  });
});

describe('a business with no active location', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let owner: TestSession;

  beforeAll(async () => {
    db = await createTestDatabase();
    owner = await createTestSession(db.pool);
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent' },
      pool: db.pool,
      clock: fixedClock(new Date(RECORDED_AT)),
    });
    await newProduct(db, { name: 'Stock With Nowhere To Sit' });
    await db.pool.query(`UPDATE inventory_locations SET is_active = false`);
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('returns the variants with no locations and a zero total', async () => {
    // Not a server error. Nowhere to put stock is an operational problem, and a
    // 500 would tell the shop nothing about what is wrong or who can fix it.
    const response = await app.inject({ method: 'GET', url: BALANCES, cookies: owner.cookies });
    expect(response.statusCode).toBe(200);
    const stock = listInventoryBalancesResponseSchema.parse(response.json());

    expect(stock).toHaveLength(1);
    expect(stock[0]?.productName).toBe('Stock With Nowhere To Sit');
    expect(stock[0]?.locations).toEqual([]);
    expect(stock[0]?.totalQuantity).toBe(0);
  });
});

describe('inventory route capability declaration', () => {
  it('declares config.capability "inventory.read" on GET /api/inventory/balances', async () => {
    // Captured from the config the route actually registers, through Fastify's
    // onRoute hook — the real value, not a literal duplicated into a test.
    const app = Fastify();
    let capturedConfig: { capability?: unknown } | undefined;
    app.addHook('onRoute', (route) => {
      if (route.method === 'GET' && route.url === BALANCES) {
        capturedConfig = route.config as { capability?: unknown };
      }
    });

    const inventory: InventoryService = {
      listLocations: async () => [],
      listStockBalances: async () => [],
    };
    const receiving: ReceivingService = {
      receiveStock: async () => {
        throw new Error('not called');
      },
    };
    registerInventoryRoutes(app, { inventory, receiving });

    expect(capturedConfig?.capability).toBe('inventory.read');
    await app.close();
  });
});
