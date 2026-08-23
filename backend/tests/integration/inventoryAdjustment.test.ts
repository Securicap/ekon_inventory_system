import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_REASONS,
  adjustStockResponseSchema,
  type ErrorBody,
  type LifecycleStatus,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { ADJUSTMENT_OPERATION_TYPE } from '../../src/modules/inventory/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `POST /api/inventory/adjust`, end to end, against real PostgreSQL.
 *
 * An adjustment says the **recorded quantity was wrong**. Nothing physical
 * happened: no delivery arrived, no customer bought anything. That is the whole
 * distinction this suite exists to hold, because it is permanent — the ledger
 * is append-only, so a correction written as an `ISSUE`, or a sale written as
 * an `ADJUSTMENT_OUT`, is wrong forever and no compensating movement can un-say
 * what the row claimed.
 *
 * So almost every assertion here reads back the row that was actually written:
 * its type, its sign, its reason, its actor, and what it did to the balance. A
 * `201` proves the route answered; only the movement proves the record was
 * corrected once, in the right direction, under the right type.
 *
 * Movements can never be deleted, so each test that posts works on its own
 * freshly created (variant, location) chain.
 */

/** Server time, from the injected clock. Inside the test session's lifetime. */
const RECORDED_AT = '2026-08-03T12:00:00.000Z';
/** Business time: the correction was made before somebody entered it. */
const OCCURRED_AT = '2026-08-03T10:15:00.000Z';

const ADJUST = '/api/inventory/adjust';

let db: TestDatabase;
let app: FastifyInstance;
/** Holds every capability, including `inventory.adjust`. */
let owner: TestSession;
/** Holds `inventory.adjust` too, under the default seed. */
let manager: TestSession;
/** Deliberately does **not** hold `inventory.adjust`, though it may remove stock. */
let employee: TestSession;

interface Chain {
  productId: string;
  variantId: string;
  locationId: string;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-A${skuCounter.toString().padStart(7, '0')}`;
}

/** A fresh product, variant, and location: one isolated movement chain. */
async function newChain(
  options: { variantLifecycle?: LifecycleStatus; locationActive?: boolean } = {},
): Promise<Chain> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, lifecycle_status, created_at, updated_at)
     VALUES ($1, 'Adjustment fixture', 'ACTIVE', $2, $2)`,
    [productId, RECORDED_AT],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, lifecycle_status, created_at, updated_at)
     VALUES ($1, $2, $3, '[]', $4, $5, $5)`,
    [variantId, productId, nextSku(), options.variantLifecycle ?? 'ACTIVE', RECORDED_AT],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, 'Adjustment fixture location', false, $2, $3, $3)`,
    [locationId, options.locationActive ?? true, RECORDED_AT],
  );

  return { productId, variantId, locationId };
}

interface Injected {
  status: number;
  body: unknown;
}

/** A well-formed adjustment body, with anything a test cares about overridden. */
function body(chain: Chain, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: newId(),
    variantId: chain.variantId,
    locationId: chain.locationId,
    quantityDelta: 3,
    reason: 'DATA_ENTRY_ERROR',
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

async function adjust(payload: unknown, session: TestSession = owner): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: ADJUST,
    cookies: session.cookies,
    payload: payload as Record<string, unknown>,
  });
  return { status: response.statusCode, body: response.json() };
}

async function adjustOk(
  payload: unknown,
  session: TestSession = owner,
): Promise<{ operationId: string; movementId: string; quantityAfter: number }> {
  const { status, body: responseBody } = await adjust(payload, session);
  expect(status, JSON.stringify(responseBody)).toBe(201);
  return adjustStockResponseSchema.parse(responseBody);
}

function errorCode(responseBody: unknown): string {
  return (responseBody as ErrorBody).error.code;
}

interface MovementRow {
  id: string;
  movement_type: string;
  quantity_delta: number;
  quantity_before: number;
  quantity_after: number;
  reason_code: string | null;
  note: string | null;
  user_id: string;
  reverses_movement_id: string | null;
  occurred_at: Date;
  recorded_at: Date;
}

async function movements(chain: Chain): Promise<MovementRow[]> {
  const { rows } = await db.pool.query<MovementRow>(
    `SELECT id, movement_type, quantity_delta, quantity_before, quantity_after,
            reason_code, note, user_id, reverses_movement_id, occurred_at, recorded_at
       FROM inventory_movements
      WHERE variant_id = $1 AND location_id = $2
      ORDER BY recorded_at, id`,
    [chain.variantId, chain.locationId],
  );
  return rows;
}

async function balance(chain: Chain): Promise<{ quantity_on_hand: number } | undefined> {
  const { rows } = await db.pool.query<{ quantity_on_hand: number }>(
    `SELECT quantity_on_hand FROM inventory_balances WHERE variant_id = $1 AND location_id = $2`,
    [chain.variantId, chain.locationId],
  );
  return rows[0];
}

async function operations(operationId: string): Promise<{ operation_type: string }[]> {
  const { rows } = await db.pool.query<{ operation_type: string }>(
    `SELECT operation_type FROM operations WHERE id = $1`,
    [operationId],
  );
  return rows;
}

/** Puts stock on the shelf the ordinary way, so an adjustment has something to correct. */
async function stock(chain: Chain, quantity: number): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/receive',
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId: chain.variantId,
      locationId: chain.locationId,
      quantity,
      occurredAt: OCCURRED_AT,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
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
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('a positive adjustment', () => {
  it('posts an ADJUSTMENT_IN with the stated delta, reason, and actor', async () => {
    const chain = await newChain();
    const result = await adjustOk(body(chain, { quantityDelta: 4, reason: 'MISSED_MOVEMENT' }));

    expect(result.quantityAfter).toBe(4);

    const [movement] = await movements(chain);
    expect(movement).toMatchObject({
      id: result.movementId,
      // Derived from the sign by the server. The request never named a type.
      movement_type: 'ADJUSTMENT_IN',
      quantity_delta: 4,
      quantity_before: 0,
      quantity_after: 4,
      reason_code: 'MISSED_MOVEMENT',
      note: null,
      // From the session, never from the body.
      user_id: owner.user.id,
      // An adjustment is not a reversal and names nothing.
      reverses_movement_id: null,
    });
    expect(movement?.occurred_at.toISOString()).toBe(OCCURRED_AT);
    expect(movement?.recorded_at.toISOString()).toBe(RECORDED_AT);

    // The projection equals the ledger (INV-6).
    expect((await balance(chain))?.quantity_on_hand).toBe(4);
  });

  it('claims its operation under inventory.adjust, not inventory.remove', async () => {
    // The operation type is what keeps two commands under one reused id from
    // being mistaken for each other — and an adjustment and a removal can move
    // the same stock in the same direction while meaning opposite things.
    const chain = await newChain();
    const request = body(chain);
    await adjustOk(request);

    expect(await operations(request.operationId as string)).toEqual([
      { operation_type: ADJUSTMENT_OPERATION_TYPE },
    ]);
  });

  it('stores an optional note beside the reason', async () => {
    const chain = await newChain();
    await adjustOk(body(chain, { note: 'Delivery on 2 August was never entered' }));

    const [movement] = await movements(chain);
    expect(movement?.note).toBe('Delivery on 2 August was never entered');
  });
});

describe('a negative adjustment', () => {
  it('posts an ADJUSTMENT_OUT and lowers the balance', async () => {
    const chain = await newChain();
    await stock(chain, 10);

    const result = await adjustOk(body(chain, { quantityDelta: -2 }));
    expect(result.quantityAfter).toBe(8);

    const posted = await movements(chain);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      movement_type: 'ADJUSTMENT_OUT',
      quantity_delta: -2,
      quantity_before: 10,
      quantity_after: 8,
      reason_code: 'DATA_ENTRY_ERROR',
    });
    expect((await balance(chain))?.quantity_on_hand).toBe(8);
  });

  it('cannot take the shelf below zero, and changes nothing when it would', async () => {
    // INV-8, through the same posting engine every other workflow uses. An
    // adjustment is a correction to a record, not a licence to hold minus three
    // items: nothing is clamped and nothing is partially applied.
    const chain = await newChain();
    await stock(chain, 3);

    const request = body(chain, { quantityDelta: -4 });
    const { status, body: responseBody } = await adjust(request);

    expect(status).toBe(422);
    expect(errorCode(responseBody)).toBe('INSUFFICIENT_STOCK');
    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(3);
    // The whole transaction rolled back, so the operation id is still free.
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });
});

describe('what the contract refuses', () => {
  it('refuses a zero delta', async () => {
    // A movement that changes nothing is not a movement, and the ledger's own
    // CHECK says so too.
    const chain = await newChain();
    const { status, body: responseBody } = await adjust(body(chain, { quantityDelta: 0 }));
    expect(status).toBe(400);
    expect(errorCode(responseBody)).toBe('VALIDATION_FAILED');
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses a fractional delta', async () => {
    // A floating-point quantity in an inventory ledger is an unfixable defect
    // once history exists (INV-10).
    const chain = await newChain();
    const { status } = await adjust(body(chain, { quantityDelta: 1.5 }));
    expect(status).toBe(400);
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses a missing reason', async () => {
    // An adjustment changes a number without the stock moving, so the reason is
    // the only account of what happened (INV-11).
    const chain = await newChain();
    const { operationId, variantId, locationId, quantityDelta, occurredAt } = body(chain);
    const { status } = await adjust({
      operationId,
      variantId,
      locationId,
      quantityDelta,
      occurredAt,
    });
    expect(status).toBe(400);
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses a reason outside the vocabulary', async () => {
    const chain = await newChain();
    const { status } = await adjust(body(chain, { reason: 'SHRINKAGE' }));
    expect(status).toBe(400);
  });

  it('refuses SOLD, which is a removal reason and never an adjustment', async () => {
    // The vocabularies are separate on purpose: `SOLD` says stock left the
    // shelf, which is an `ISSUE`. A sale nobody recorded is `MISSED_MOVEMENT`,
    // and flattening the two would cost the shop the difference between trade
    // it knows about and bookkeeping it is catching up on.
    const chain = await newChain();
    const { status } = await adjust(body(chain, { reason: 'SOLD' }));
    expect(status).toBe(400);
  });

  it('requires a note when the reason is OTHER', async () => {
    // `OTHER` with nothing beside it records that somebody changed a balance
    // and declined to say why.
    const chain = await newChain();
    const { status, body: responseBody } = await adjust(body(chain, { reason: 'OTHER' }));
    expect(status).toBe(400);
    expect(errorCode(responseBody)).toBe('VALIDATION_FAILED');

    const accepted = await adjustOk(
      body(chain, { reason: 'OTHER', note: 'Two boxes found behind the counter' }),
    );
    expect(accepted.quantityAfter).toBe(3);
  });

  it.each([
    ['movementType', { movementType: 'ADJUSTMENT_IN' }],
    ['userId', { userId: newId() }],
    ['reasonCode', { reasonCode: 'DATA_ENTRY_ERROR' }],
    ['recordedAt', { recordedAt: RECORDED_AT }],
    ['quantityBefore', { quantityBefore: 0 }],
    ['movementId', { movementId: newId() }],
  ])('refuses a body carrying %s', async (_field, extra) => {
    // `.strict()`, so a server-owned field is rejected rather than ignored: a
    // client that can send one and get a 201 will keep sending it, and
    // eventually somebody will wire it up.
    const chain = await newChain();
    const { status } = await adjust(body(chain, extra));
    expect(status).toBe(400);
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses a variant that does not exist', async () => {
    const chain = await newChain();
    const { status, body: responseBody } = await adjust(body(chain, { variantId: newId() }));
    expect(status).toBe(404);
    expect(errorCode(responseBody)).toBe('NOT_FOUND');
  });

  it('refuses a location that is no longer active', async () => {
    const chain = await newChain({ locationActive: false });
    const { status, body: responseBody } = await adjust(body(chain));
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    expect(await movements(chain)).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('corrects a DISCONTINUED variant, because a correction is not a replenishment', async () => {
    // The rule that had to be stated separately from receiving's. Discontinuing
    // something on Friday cannot make Thursday's mis-keyed receipt permanent.
    const chain = await newChain();
    await stock(chain, 5);
    await db.pool.query(
      `UPDATE product_variants SET lifecycle_status = 'DISCONTINUED' WHERE id = $1`,
      [chain.variantId],
    );

    const result = await adjustOk(body(chain, { quantityDelta: -1 }));
    expect(result.quantityAfter).toBe(4);
  });

  it('refuses an ARCHIVED variant, and says how to proceed', async () => {
    // A correction against archived merchandise would put units on a shelf the
    // archive asserts is empty, behind a status that has removed the item from
    // every operational screen. Nothing here changes the lifecycle to get its
    // own write through.
    const chain = await newChain({ variantLifecycle: 'ARCHIVED' });
    const request = body(chain);
    const { status, body: responseBody } = await adjust(request);

    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    expect((responseBody as ErrorBody).error.message).toContain('DISCONTINUED');
    expect(await movements(chain)).toHaveLength(0);
    expect(await operations(request.operationId as string)).toHaveLength(0);

    // And the lifecycle is exactly as it was.
    const { rows } = await db.pool.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM product_variants WHERE id = $1`,
      [chain.variantId],
    );
    expect(rows[0]?.lifecycle_status).toBe('ARCHIVED');
  });
});

describe('idempotency', () => {
  it('posts once for a retried command and answers with the same movement', async () => {
    const chain = await newChain();
    const request = body(chain, { quantityDelta: 6, note: 'Recount of the back shelf' });

    const first = await adjustOk(request);
    const replay = await adjustOk(request);

    expect(replay).toEqual(first);
    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(6);
    expect(await operations(request.operationId as string)).toHaveLength(1);
  });

  it('refuses the same operation id carrying a different quantity', async () => {
    const chain = await newChain();
    const request = body(chain, { quantityDelta: 6 });
    await adjustOk(request);

    const { status, body: responseBody } = await adjust({ ...request, quantityDelta: 7 });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(6);
  });

  it('refuses the same operation id carrying a different reason', async () => {
    const chain = await newChain();
    const request = body(chain, { reason: 'DATA_ENTRY_ERROR' });
    await adjustOk(request);

    const { status, body: responseBody } = await adjust({ ...request, reason: 'MISSED_MOVEMENT' });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
  });

  it('refuses the same operation id carrying a different note', async () => {
    // The note is a business field here, not decoration: two different accounts
    // of what went wrong under one id is a mistake worth refusing rather than
    // resolving by arrival order.
    const chain = await newChain();
    const request = body(chain, { reason: 'OTHER', note: 'Counted wrong' });
    await adjustOk(request);

    const { status, body: responseBody } = await adjust({
      ...request,
      note: 'Delivery never entered',
    });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
  });

  it('recognizes the same instant written with an offset', async () => {
    const chain = await newChain();
    const request = body(chain, { occurredAt: '2026-08-03T10:15:00.000Z' });
    const first = await adjustOk(request);

    const replay = await adjustOk({ ...request, occurredAt: '2026-08-03T05:15:00.000-05:00' });
    expect(replay).toEqual(first);
    expect(await movements(chain)).toHaveLength(1);
  });
});

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const chain = await newChain();
    const response = await app.inject({ method: 'POST', url: ADJUST, payload: body(chain) });
    expect(response.statusCode).toBe(401);
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses an employee, who may remove stock but not adjust it', async () => {
    // The distinction the two capabilities exist for. Removing stock says what
    // happened; adjusting says the record was wrong, and the second can make a
    // shortfall disappear — so it is the one that has to be given on purpose.
    const chain = await newChain();
    await stock(chain, 5);

    const { status, body: responseBody } = await adjust(body(chain), employee);
    expect(status).toBe(403);
    expect(errorCode(responseBody)).toBe('FORBIDDEN');
    expect(await movements(chain)).toHaveLength(1);

    // The same person may still record that stock left, which is the job.
    const removal = await app.inject({
      method: 'POST',
      url: '/api/inventory/remove',
      cookies: employee.cookies,
      payload: {
        operationId: newId(),
        variantId: chain.variantId,
        locationId: chain.locationId,
        quantity: 1,
        reason: 'SOLD',
        occurredAt: OCCURRED_AT,
      },
    });
    expect(removal.statusCode).toBe(201);
  });

  it('allows a manager', async () => {
    const chain = await newChain();
    const result = await adjustOk(body(chain, { quantityDelta: 2 }), manager);

    const [movement] = await movements(chain);
    expect(movement?.user_id).toBe(manager.user.id);
    expect(result.quantityAfter).toBe(2);
  });
});

describe('the reason vocabulary', () => {
  it('is exactly what the shared contract publishes', async () => {
    // Every published reason is genuinely accepted, so a screen offering one
    // cannot present a choice the server refuses.
    for (const reason of ADJUSTMENT_REASONS) {
      const chain = await newChain();
      const result = await adjustOk(
        body(chain, { reason, note: reason === 'OTHER' ? 'Explained' : undefined }),
      );
      const [movement] = await movements(chain);
      expect(movement?.reason_code).toBe(reason);
      expect(result.quantityAfter).toBe(3);
    }
  });
});
