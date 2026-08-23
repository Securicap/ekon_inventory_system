import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  movementHistoryPageSchema,
  reverseMovementResponseSchema,
  type ErrorBody,
  type LifecycleStatus,
} from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { REVERSAL_OPERATION_TYPE } from '../../src/modules/inventory/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { lockBalanceRow, runConcurrentlyBehindLock } from '../helpers/ledgerConcurrency.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `POST /api/inventory/reverse`, end to end, against real PostgreSQL.
 *
 * A reversal is the one workflow that reaches back into settled history, so the
 * assertions that matter are about what it does **not** do. The original row is
 * read back byte for byte after every reversal in this suite: same id, same
 * type, same quantities, same reason, same actor, same timestamps. A correction
 * is new history, and a system that edited the old row instead would pass every
 * balance assertion here while destroying the only record of what went wrong.
 *
 * The second thing this suite exists for is the stock floor. A reversal works
 * against the **current** balance, not against the quantity that followed the
 * original movement, so reversing a receipt whose stock has since been sold is
 * refused rather than allowed to leave the shelf owing units (INV-8).
 */

const RECORDED_AT = '2026-08-03T12:00:00.000Z';
const OCCURRED_AT = '2026-08-03T10:15:00.000Z';

const REVERSE = '/api/inventory/reverse';

let db: TestDatabase;
let app: FastifyInstance;
/** Holds every capability, including `inventory.reverse`. */
let owner: TestSession;
/** Holds `inventory.adjust` and `inventory.reverse` under the default seed. */
let manager: TestSession;
/** Holds neither. */
let employee: TestSession;

interface Chain {
  productId: string;
  variantId: string;
  locationId: string;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-V${skuCounter.toString().padStart(7, '0')}`;
}

async function newChain(options: { variantLifecycle?: LifecycleStatus } = {}): Promise<Chain> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, lifecycle_status, created_at, updated_at)
     VALUES ($1, 'Reversal fixture', 'ACTIVE', $2, $2)`,
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
     VALUES ($1, 'Reversal fixture location', false, true, $2, $2)`,
    [locationId, RECORDED_AT],
  );

  return { productId, variantId, locationId };
}

interface Injected {
  status: number;
  body: unknown;
}

function body(
  movementId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operationId: newId(),
    movementId,
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

async function reverse(payload: unknown, session: TestSession = owner): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: REVERSE,
    cookies: session.cookies,
    payload: payload as Record<string, unknown>,
  });
  return { status: response.statusCode, body: response.json() };
}

async function reverseOk(
  payload: unknown,
  session: TestSession = owner,
): Promise<{ operationId: string; movementId: string; quantityAfter: number }> {
  const { status, body: responseBody } = await reverse(payload, session);
  expect(status, JSON.stringify(responseBody)).toBe(201);
  return reverseMovementResponseSchema.parse(responseBody);
}

function errorCode(responseBody: unknown): string {
  return (responseBody as ErrorBody).error.code;
}

/** Every column of one movement, for the byte-identical comparison. */
async function movementRow(id: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT * FROM inventory_movements WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function movements(chain: Chain): Promise<
  {
    id: string;
    movement_type: string;
    quantity_delta: number;
    quantity_before: number;
    quantity_after: number;
    reason_code: string | null;
    note: string | null;
    user_id: string;
    reverses_movement_id: string | null;
    reverses_movement_type: string | null;
    previous_movement_id: string | null;
  }[]
> {
  const { rows } = await db.pool.query(
    `SELECT id, movement_type, quantity_delta, quantity_before, quantity_after,
            reason_code, note, user_id, reverses_movement_id, reverses_movement_type,
            previous_movement_id
       FROM inventory_movements
      WHERE variant_id = $1 AND location_id = $2
      ORDER BY recorded_at, id`,
    [chain.variantId, chain.locationId],
  );
  return rows as never;
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

/** Books stock in through the ordinary workflow and returns its movement id. */
async function receive(chain: Chain, quantity: number): Promise<string> {
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
  return (response.json() as { movementId: string }).movementId;
}

/** Takes stock off the shelf through the ordinary workflow. */
async function issue(chain: Chain, quantity: number, reason = 'SOLD'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/remove',
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId: chain.variantId,
      locationId: chain.locationId,
      quantity,
      reason,
      occurredAt: OCCURRED_AT,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return (response.json() as { movementId: string }).movementId;
}

/** Corrects a recorded quantity through the ordinary workflow. */
async function adjustBy(chain: Chain, quantityDelta: number): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/adjust',
    cookies: owner.cookies,
    payload: {
      operationId: newId(),
      variantId: chain.variantId,
      locationId: chain.locationId,
      quantityDelta,
      reason: 'DATA_ENTRY_ERROR',
      occurredAt: OCCURRED_AT,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return (response.json() as { movementId: string }).movementId;
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

describe('reversing a receipt', () => {
  it('appends a REVERSAL that exactly negates it, and leaves the original alone', async () => {
    const chain = await newChain();
    const original = await receive(chain, 10);
    const before = await movementRow(original);

    const result = await reverseOk(body(original, { note: 'Delivery entered twice' }));
    expect(result.quantityAfter).toBe(0);

    const posted = await movements(chain);
    expect(posted).toHaveLength(2);

    // The original, byte for byte. Not one column moved: a correction is new
    // history, and the database refuses an UPDATE on this table anyway (INV-1).
    expect(await movementRow(original)).toEqual(before);

    expect(posted[1]).toMatchObject({
      id: result.movementId,
      movement_type: 'REVERSAL',
      // Derived from the original, never from the request.
      quantity_delta: -10,
      quantity_before: 10,
      quantity_after: 0,
      reverses_movement_id: original,
      reverses_movement_type: 'RECEIPT',
      // A reversal carries its reason in the movement it reverses.
      reason_code: null,
      note: 'Delivery entered twice',
      user_id: owner.user.id,
      // Chained onto the movement that was current, exactly like any other.
      previous_movement_id: original,
    });

    expect((await balance(chain))?.quantity_on_hand).toBe(0);
  });

  it('claims its operation under inventory.reverse', async () => {
    const chain = await newChain();
    const original = await receive(chain, 4);
    const request = body(original);
    await reverseOk(request);

    expect(await operations(request.operationId as string)).toEqual([
      { operation_type: REVERSAL_OPERATION_TYPE },
    ]);
  });
});

describe('reversing an issue', () => {
  it('puts the stock back, on the same shelf, in the same quantity', async () => {
    const chain = await newChain();
    await receive(chain, 10);
    const original = await issue(chain, 3);
    const before = await movementRow(original);

    const result = await reverseOk(body(original));
    expect(result.quantityAfter).toBe(10);

    const posted = await movements(chain);
    expect(posted[2]).toMatchObject({
      movement_type: 'REVERSAL',
      quantity_delta: 3,
      quantity_before: 7,
      quantity_after: 10,
      reverses_movement_id: original,
      reverses_movement_type: 'ISSUE',
    });
    expect(await movementRow(original)).toEqual(before);
    expect((await balance(chain))?.quantity_on_hand).toBe(10);
  });
});

describe('reversing an adjustment', () => {
  it('undoes the correction, and records that it was the correction being undone', async () => {
    const chain = await newChain();
    await receive(chain, 5);
    const original = await adjustBy(chain, 4);

    const result = await reverseOk(body(original));
    expect(result.quantityAfter).toBe(5);

    const posted = await movements(chain);
    expect(posted[2]).toMatchObject({
      movement_type: 'REVERSAL',
      quantity_delta: -4,
      reverses_movement_id: original,
      reverses_movement_type: 'ADJUSTMENT_IN',
    });
  });
});

describe('the stock floor', () => {
  it('refuses a reversal that would leave the shelf owing units', async () => {
    // The case the workflow exists to get right. Ten arrived, three were sold,
    // and reversing the receipt would leave −3 — so it is refused, and the
    // remedy is to correct the later movements first. A historical receipt is
    // not permission to break INV-8, and nothing is clamped.
    const chain = await newChain();
    const receipt = await receive(chain, 10);
    await issue(chain, 3);

    const request = body(receipt);
    const { status, body: responseBody } = await reverse(request);

    expect(status).toBe(422);
    expect(errorCode(responseBody)).toBe('INSUFFICIENT_STOCK');
    expect(await movements(chain)).toHaveLength(2);
    expect((await balance(chain))?.quantity_on_hand).toBe(7);
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });

  it('permits the same reversal once the later movement has been reversed', async () => {
    // The documented sequence: correct the later movements, then the earlier
    // one. Nothing about the ledger changed except that more history was
    // appended to it.
    const chain = await newChain();
    const receipt = await receive(chain, 10);
    const sale = await issue(chain, 3);

    expect((await reverse(body(receipt))).status).toBe(422);

    await reverseOk(body(sale));
    expect((await balance(chain))?.quantity_on_hand).toBe(10);

    const result = await reverseOk(body(receipt));
    expect(result.quantityAfter).toBe(0);
    expect(await movements(chain)).toHaveLength(4);
  });
});

describe('what a reversal refuses', () => {
  it('refuses a movement that does not exist', async () => {
    const { status, body: responseBody } = await reverse(body(newId()));
    expect(status).toBe(404);
    expect(errorCode(responseBody)).toBe('NOT_FOUND');
  });

  it('refuses to reverse the same movement twice', async () => {
    const chain = await newChain();
    const original = await receive(chain, 6);
    const first = await reverseOk(body(original));

    const { status, body: responseBody } = await reverse(body(original));
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    // The message names the reversal that already exists, so whoever is looking
    // can go and read it.
    expect((responseBody as ErrorBody).error.message).toContain(first.movementId);

    expect(await movements(chain)).toHaveLength(2);
    expect((await balance(chain))?.quantity_on_hand).toBe(0);
  });

  it('refuses to reverse a reversal', async () => {
    // Two compensating movements chasing each other is not a correction of a
    // correction: it is a way to move stock indefinitely while every row claims
    // to be undoing something. Re-post the original command instead.
    const chain = await newChain();
    const original = await receive(chain, 6);
    const reversal = await reverseOk(body(original));

    const { status, body: responseBody } = await reverse(body(reversal.movementId));
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    expect(await movements(chain)).toHaveLength(2);
  });

  it.each([
    ['variantId', { variantId: newId() }],
    ['locationId', { locationId: newId() }],
    ['quantityDelta', { quantityDelta: -5 }],
    ['movementType', { movementType: 'REVERSAL' }],
    ['reversesMovementId', { reversesMovementId: newId() }],
    ['userId', { userId: newId() }],
  ])('refuses a body carrying %s', async (_field, extra) => {
    // Every one of these is derivable from the original movement, so a second
    // statement of it could only ever disagree. `.strict()` refuses rather than
    // ignores.
    const chain = await newChain();
    const original = await receive(chain, 6);

    const { status } = await reverse(body(original, extra));
    expect(status).toBe(400);
    expect(await movements(chain)).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('reverses history of DISCONTINUED merchandise', async () => {
    // Corrections concern ledger truth, not replenishment policy. Discontinuing
    // something must not freeze its history as uncorrectable.
    const chain = await newChain();
    const original = await receive(chain, 4);
    await db.pool.query(
      `UPDATE product_variants SET lifecycle_status = 'DISCONTINUED' WHERE id = $1`,
      [chain.variantId],
    );

    const result = await reverseOk(body(original));
    expect(result.quantityAfter).toBe(0);
  });

  it('refuses ARCHIVED merchandise, and says to restore it first', async () => {
    const chain = await newChain();
    const original = await receive(chain, 4);
    await issue(chain, 4);
    await db.pool.query(`UPDATE product_variants SET lifecycle_status = 'ARCHIVED' WHERE id = $1`, [
      chain.variantId,
    ]);

    const request = body(original);
    const { status, body: responseBody } = await reverse(request);
    expect(status).toBe(409);
    expect((responseBody as ErrorBody).error.message).toContain('DISCONTINUED');
    expect(await operations(request.operationId as string)).toHaveLength(0);

    // Restoring it makes the correction possible, and the reversal itself does
    // not touch the lifecycle either way.
    await db.pool.query(
      `UPDATE product_variants SET lifecycle_status = 'DISCONTINUED' WHERE id = $1`,
      [chain.variantId],
    );
    const { status: retried } = await reverse(body(original));
    // Reversing the receipt of 4 that has since been issued would leave −4.
    expect(retried).toBe(422);
  });
});

describe('idempotency', () => {
  it('posts once for a retried command and answers with the same reversal', async () => {
    const chain = await newChain();
    const original = await receive(chain, 8);
    const request = body(original, { note: 'Wrong item booked in' });

    const first = await reverseOk(request);
    const replay = await reverseOk(request);

    expect(replay).toEqual(first);
    expect(await movements(chain)).toHaveLength(2);
    expect((await balance(chain))?.quantity_on_hand).toBe(0);
    expect(await operations(request.operationId as string)).toHaveLength(1);
  });

  it('refuses the same operation id naming a different movement', async () => {
    const chain = await newChain();
    const first = await receive(chain, 8);
    const second = await adjustBy(chain, 2);
    const request = body(first);
    await reverseOk(request);

    const { status, body: responseBody } = await reverse({ ...request, movementId: second });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect(await movements(chain)).toHaveLength(3);
  });

  it('refuses the same operation id carrying a different note', async () => {
    const chain = await newChain();
    const original = await receive(chain, 8);
    const request = body(original, { note: 'Wrong item' });
    await reverseOk(request);

    const { status, body: responseBody } = await reverse({ ...request, note: 'Wrong quantity' });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
  });
});

describe('concurrency', () => {
  it('lets exactly one of two simultaneous reversals of one movement succeed', async () => {
    // Both attempts read "not yet reversed" and both try to append. The
    // `UNIQUE (reverses_movement_id)` constraint is the final protection
    // (INV-2), and the loser is answered with the same `409` it would have got
    // had it seen the existing reversal — never a 500, and never a second
    // movement that removed the stock twice.
    const chain = await newChain();
    const original = await receive(chain, 10);

    const results = await runConcurrentlyBehindLock(
      db.pool,
      lockBalanceRow(chain),
      [body(original), body(original)].map((payload) => () => reverse(payload)),
    );

    const answers = results.map((result) =>
      result.status === 'fulfilled' ? result.value.status : 500,
    );
    expect(answers.filter((status) => status === 201)).toHaveLength(1);
    expect(answers.filter((status) => status === 409)).toHaveLength(1);

    // One reversal, one balance, and the original untouched.
    const posted = await movements(chain);
    expect(posted).toHaveLength(2);
    expect(posted[1]?.movement_type).toBe('REVERSAL');
    expect((await balance(chain))?.quantity_on_hand).toBe(0);
  });
});

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const chain = await newChain();
    const original = await receive(chain, 3);
    const response = await app.inject({ method: 'POST', url: REVERSE, payload: body(original) });
    expect(response.statusCode).toBe(401);
    expect(await movements(chain)).toHaveLength(1);
  });

  it('refuses an employee', async () => {
    const chain = await newChain();
    const original = await receive(chain, 3);
    const { status, body: responseBody } = await reverse(body(original), employee);
    expect(status).toBe(403);
    expect(errorCode(responseBody)).toBe('FORBIDDEN');
    expect(await movements(chain)).toHaveLength(1);
  });

  it('allows a manager, and records them as the actor', async () => {
    const chain = await newChain();
    const original = await receive(chain, 3);
    await reverseOk(body(original), manager);

    const posted = await movements(chain);
    expect(posted[1]?.user_id).toBe(manager.user.id);
  });
});

describe('history', () => {
  it('shows the reversal, what it reverses, and that the original was reversed', async () => {
    const chain = await newChain();
    const original = await receive(chain, 7);
    const reversal = await reverseOk(body(original, { note: 'Booked in twice' }));

    const response = await app.inject({
      method: 'GET',
      url: `/api/inventory/movements?variantId=${chain.variantId}`,
      cookies: owner.cookies,
    });
    expect(response.statusCode).toBe(200);
    const page = movementHistoryPageSchema.parse(response.json());

    // Newest recorded first.
    expect(page.items.map((item) => item.id)).toEqual([reversal.movementId, original]);

    expect(page.items[0]).toMatchObject({
      movementType: 'REVERSAL',
      quantityDelta: -7,
      quantityBefore: 7,
      quantityAfter: 0,
      reversesMovementId: original,
      reversedByMovementId: null,
      note: 'Booked in twice',
    });

    // And the original says it was corrected, so nobody reads it as stock the
    // shop still received.
    expect(page.items[1]).toMatchObject({
      movementType: 'RECEIPT',
      quantityDelta: 7,
      reversesMovementId: null,
      reversedByMovementId: reversal.movementId,
    });
  });

  it('filters by movementType=REVERSAL through the existing contract', async () => {
    const chain = await newChain();
    const original = await receive(chain, 2);
    const reversal = await reverseOk(body(original));

    const response = await app.inject({
      method: 'GET',
      url: `/api/inventory/movements?variantId=${chain.variantId}&movementType=REVERSAL`,
      cookies: owner.cookies,
    });
    const page = movementHistoryPageSchema.parse(response.json());
    expect(page.items.map((item) => item.id)).toEqual([reversal.movementId]);
  });
});
