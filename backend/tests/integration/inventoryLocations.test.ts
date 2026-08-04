import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listInventoryLocationsResponseSchema } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { registerInventoryRoutes } from '../../src/modules/inventory/routes.js';
import type { InventoryService } from '../../src/modules/inventory/index.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

const SEED_NAME = 'Main Store';
const SEED_TIMESTAMP = '2026-08-01T00:00:00.000Z';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Inserts a location row directly, for constraint and ordering checks. */
async function insertLocation(
  db: TestDatabase,
  fields: { name?: string; isDefault?: boolean; isActive?: boolean; createdAt?: string },
): Promise<void> {
  const createdAt = fields.createdAt ?? '2026-08-02T00:00:00Z';
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [
      newId(),
      fields.name ?? 'Backroom',
      fields.isDefault ?? false,
      fields.isActive ?? true,
      createdAt,
    ],
  );
}

describe('inventory_locations schema and seed', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase(); // migrates to head, including 0004
  });

  afterAll(async () => {
    await db.drop();
  });

  it('creates the inventory_locations table', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'inventory_locations'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('seeds exactly one location: a default, active "Main Store" with a valid uuid', async () => {
    const { rows } = await db.pool.query<{
      id: string;
      name: string;
      is_default: boolean;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(`SELECT id, name, is_default, is_active, created_at, updated_at FROM inventory_locations`);

    expect(rows).toHaveLength(1);
    const seed = rows[0]!;
    expect(seed.name).toBe(SEED_NAME);
    expect(seed.is_default).toBe(true);
    expect(seed.is_active).toBe(true);
    expect(seed.id).toMatch(UUID_PATTERN);
    // Deterministic seed timestamps, equal to each other.
    expect(seed.created_at.toISOString()).toBe(SEED_TIMESTAMP);
    expect(seed.updated_at.toISOString()).toBe(SEED_TIMESTAMP);
  });

  it('rejects a second default location via the partial unique index', async () => {
    await expect(
      insertLocation(db, { name: 'Second Default', isDefault: true }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('allows more than one non-default location', async () => {
    await insertLocation(db, { name: 'Backroom' });
    await insertLocation(db, { name: 'Storage Unit' });
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_locations WHERE is_default = false`,
    );
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(2);
  });

  it('allows a valid inactive non-default location', async () => {
    await expect(
      insertLocation(db, { name: 'Closed Kiosk', isActive: false }),
    ).resolves.toBeUndefined();
  });

  it('rejects a blank name', async () => {
    await expect(insertLocation(db, { name: '' })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a whitespace-padded name', async () => {
    await expect(insertLocation(db, { name: '  Padded  ' })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('rejects a name longer than 120 characters', async () => {
    await expect(insertLocation(db, { name: 'x'.repeat(121) })).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('GET /api/inventory/locations', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  // The route requires `inventory.read`. These tests are about what it returns,
  // not about who may call it, so they arrive as somebody who may.
  let owner: TestSession;

  beforeAll(async () => {
    db = await createTestDatabase();
    owner = await createTestSession(db.pool);
    app = await buildApp({
      config: { ...loadConfig(), LOG_LEVEL: 'silent' },
      pool: db.pool,
      clock: fixedClock(new Date('2026-08-03T12:00:00.000Z')),
    });
    // Extra locations to exercise ordering and inactive visibility.
    await insertLocation(db, {
      name: 'Backroom',
      isActive: true,
      createdAt: '2026-08-02T00:00:00Z',
    });
    await insertLocation(db, {
      name: 'Closed Kiosk',
      isActive: false,
      createdAt: '2026-08-03T00:00:00Z',
    });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('returns 200 with a body that validates against the shared schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/locations',
      cookies: owner.cookies,
    });
    expect(res.statusCode).toBe(200);
    const locations = listInventoryLocationsResponseSchema.parse(res.json());
    expect(locations.length).toBe(3);
  });

  it('returns the seeded default location, correctly mapped', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/locations',
      cookies: owner.cookies,
    });
    const locations = listInventoryLocationsResponseSchema.parse(res.json());
    const main = locations.find((l) => l.name === SEED_NAME);
    expect(main).toBeDefined();
    expect(main?.isDefault).toBe(true);
    expect(main?.isActive).toBe(true);
    expect(main?.createdAt).toBe(SEED_TIMESTAMP);
  });

  it('orders the default first, then by creation time, and keeps inactive visible', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/locations',
      cookies: owner.cookies,
    });
    const locations = listInventoryLocationsResponseSchema.parse(res.json());
    expect(locations.map((l) => l.name)).toEqual([SEED_NAME, 'Backroom', 'Closed Kiosk']);
    // The default is first even though it is not the earliest by any tie-break rule.
    expect(locations[0]?.isDefault).toBe(true);
    // Inactive location is still returned.
    expect(locations.find((l) => l.name === 'Closed Kiosk')?.isActive).toBe(false);
  });
});

describe('inventory route capability declaration', () => {
  it('declares config.capability "inventory.read" on GET /api/inventory/locations', async () => {
    // Capture the config the route actually registers via Fastify's onRoute
    // hook — the real value, not a duplicated literal. No database needed.
    const app = Fastify();
    let capturedConfig: { capability?: unknown } | undefined;
    app.addHook('onRoute', (route) => {
      if (route.method === 'GET' && route.url === '/api/inventory/locations') {
        capturedConfig = route.config as { capability?: unknown };
      }
    });

    const stubService: InventoryService = { listLocations: async () => [] };
    registerInventoryRoutes(app, stubService);

    expect(capturedConfig?.capability).toBe('inventory.read');
    await app.close();
  });
});
