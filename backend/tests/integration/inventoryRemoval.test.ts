import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REMOVAL_REASONS, removeStockResponseSchema, type ErrorBody } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { REMOVAL_OPERATION_TYPE } from '../../src/modules/inventory/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { lockBalanceRow, runConcurrentlyBehindLock } from '../helpers/ledgerConcurrency.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `POST /api/inventory/remove`, end to end, against real PostgreSQL.
 *
 * The point of this suite is the database, not the status codes. Removal is the
 * first workflow that takes stock *out* of the ledger, so almost every
 * assertion here reads back the rows that were actually written — the
 * operation, the movement, the balance — and the failure cases assert that
 * *nothing* was written. A `201` proves the route answered; only the movement
 * row proves the stock left once, in the right direction, off the right shelf,
 * for the right reason, attributed to the right person.
 *
 * The case this suite exists for is the shortfall. Stock can never go below
 * zero, and a removal that would take it there must leave the ledger exactly as
 * it found it: no partial removal, no clamping to what was available, no
 * quietly taking the rest from another location. That rule belongs to the
 * posting engine, and what is proved here is that removal really delegates to
 * it rather than deciding for itself.
 *
 * Movements can never be deleted, so each test that posts works on its own
 * freshly created (variant, location) chain.
 */

/** Server time, from the injected clock. Inside the test session's lifetime. */
const RECORDED_AT = '2026-08-03T12:00:00.000Z';
/** Business time: the stock left before somebody got round to entering it. */
const OCCURRED_AT = '2026-08-03T10:15:00.000Z';

let db: TestDatabase;
let app: FastifyInstance;
/** Holds every capability, including `inventory.remove`. */
let owner: TestSession;
/** A second person who may also remove — used to change the hashed actor. */
let manager: TestSession;

interface Chain {
  variantId: string;
  locationId: string;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-X${skuCounter.toString().padStart(7, '0')}`;
}

/** A fresh product, variant, and location: one isolated movement chain. */
async function newChain(
  options: { variantActive?: boolean; locationActive?: boolean } = {},
): Promise<Chain> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, created_at, updated_at)
     VALUES ($1, 'Removal fixture', $2, $2)`,
    [productId, RECORDED_AT],
  );

  const variantId = newId();
  await db.pool.query(
    `INSERT INTO product_variants
       (id, product_id, sku, variant_signature, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, '[]', $4, $5, $5)`,
    [variantId, productId, nextSku(), options.variantActive ?? true, RECORDED_AT],
  );

  const locationId = newId();
  await db.pool.query(
    `INSERT INTO inventory_locations (id, name, is_default, is_active, created_at, updated_at)
     VALUES ($1, 'Removal fixture location', false, $2, $3, $3)`,
    [locationId, options.locationActive ?? true, RECORDED_AT],
  );

  return { variantId, locationId };
}

/** Retires a variant, as a catalog deactivation will once it exists. */
async function deactivateVariant(chain: Chain): Promise<void> {
  await db.pool.query(`UPDATE product_variants SET is_active = false WHERE id = $1`, [
    chain.variantId,
  ]);
}

/** Closes a location, as location management will once it exists. */
async function deactivateLocation(chain: Chain): Promise<void> {
  await db.pool.query(`UPDATE inventory_locations SET is_active = false WHERE id = $1`, [
    chain.locationId,
  ]);
}

interface Injected {
  status: number;
  body: unknown;
}

async function post(
  url: string,
  payload: unknown,
  session: TestSession | null = owner,
): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    ...(session ? { cookies: session.cookies } : {}),
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { status: response.statusCode, body: response.json() };
}

/**
 * Puts stock on a shelf, through the real receiving endpoint.
 *
 * Not an `INSERT` into `inventory_balances`. A hand-written balance row would
 * be a shelf with no history behind it, and every removal here would then be
 * tested against a chain the posting engine did not build. Receiving is how
 * stock gets onto a shelf; this suite starts where a real shop starts.
 */
async function stock(chain: Chain, quantity: number): Promise<void> {
  const { status, body } = await post('/api/inventory/receive', {
    operationId: newId(),
    variantId: chain.variantId,
    locationId: chain.locationId,
    quantity,
    occurredAt: '2026-08-03T08:00:00.000Z',
  });
  expect(status, JSON.stringify(body)).toBe(201);
}

/** A well-formed removal body, with anything a test cares about overridden. */
function body(chain: Chain, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: newId(),
    variantId: chain.variantId,
    locationId: chain.locationId,
    quantity: 3,
    reason: 'SOLD',
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

async function remove(payload: unknown, session: TestSession | null = owner): Promise<Injected> {
  return post('/api/inventory/remove', payload, session);
}

/** Posts a body that is expected to succeed, and returns the parsed result. */
async function removeOk(payload: unknown, session: TestSession = owner) {
  const { status, body: responseBody } = await remove(payload, session);
  expect(status, JSON.stringify(responseBody)).toBe(201);
  return removeStockResponseSchema.parse(responseBody);
}

function errorCode(responseBody: unknown): string {
  return (responseBody as ErrorBody).error.code;
}

interface MovementRow {
  id: string;
  variant_id: string;
  location_id: string;
  movement_type: string;
  quantity_delta: number;
  quantity_before: number;
  quantity_after: number;
  previous_movement_id: string | null;
  reverses_movement_id: string | null;
  operation_id: string;
  reason_code: string | null;
  note: string | null;
  user_id: string;
  occurred_at: Date;
  recorded_at: Date;
}

/** Every movement on one chain, oldest first. */
async function movements(chain: Chain): Promise<MovementRow[]> {
  const { rows } = await db.pool.query<MovementRow>(
    `SELECT * FROM inventory_movements
      WHERE variant_id = $1 AND location_id = $2
      ORDER BY recorded_at, id`,
    [chain.variantId, chain.locationId],
  );
  return rows;
}

/** Only the issues on a chain — what this workflow is responsible for. */
async function issues(chain: Chain): Promise<MovementRow[]> {
  return (await movements(chain)).filter((movement) => movement.movement_type === 'ISSUE');
}

interface BalanceRow {
  quantity_on_hand: number;
  last_movement_id: string | null;
}

async function balance(chain: Chain): Promise<BalanceRow | undefined> {
  const { rows } = await db.pool.query<BalanceRow>(
    `SELECT quantity_on_hand, last_movement_id
       FROM inventory_balances WHERE variant_id = $1 AND location_id = $2`,
    [chain.variantId, chain.locationId],
  );
  return rows[0];
}

interface OperationRow {
  id: string;
  operation_type: string;
  request_hash: string;
  result_resource_type: string | null;
  result_resource_id: string | null;
  created_at: Date;
}

async function operations(operationId: string): Promise<OperationRow[]> {
  const { rows } = await db.pool.query<OperationRow>(`SELECT * FROM operations WHERE id = $1`, [
    operationId,
  ]);
  return rows;
}

beforeAll(async () => {
  db = await createTestDatabase();
  owner = await createTestSession(db.pool);
  manager = await createTestSession(db.pool, { role: 'MANAGER' });
  app = await buildApp({
    config: { ...loadConfig(), LOG_LEVEL: 'silent' },
    pool: db.pool,
    // The server clock. Deliberately later than the business time every request
    // states, so the two can never be confused for one another.
    clock: fixedClock(new Date(RECORDED_AT)),
  });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('recording stock that left', () => {
  it('appends one ISSUE, moves the balance down, and completes the operation', async () => {
    const chain = await newChain();
    await stock(chain, 10);
    const request = body(chain, { quantity: 4, reason: 'SOLD' });

    const result = await removeOk(request);

    // The response is the shared contract and nothing more. The reason is not
    // echoed: the client sent it.
    expect(Object.keys(result).sort()).toEqual(['movementId', 'operationId', 'quantityAfter']);
    expect(result.operationId).toBe(request.operationId);
    expect(result.quantityAfter).toBe(6);

    const posted = await issues(chain);
    expect(posted).toHaveLength(1);
    const movement = posted[0]!;

    expect(movement.id).toBe(result.movementId);
    expect(movement.variant_id).toBe(chain.variantId);
    expect(movement.location_id).toBe(chain.locationId);
    // The workflow chose the type and the sign, not the request. The request
    // said `4`; the ledger says `-4`.
    expect(movement.movement_type).toBe('ISSUE');
    expect(movement.quantity_delta).toBe(-4);
    expect(movement.quantity_before).toBe(10);
    expect(movement.quantity_after).toBe(6);
    expect(movement.reverses_movement_id).toBeNull();
    // The business reason, stored as the machine-readable code it arrived as.
    expect(movement.reason_code).toBe('SOLD');
    expect(movement.note).toBeNull();

    // Attribution is the session's, and the request never mentioned a user.
    expect(movement.user_id).toBe(owner.user.id);

    // Business time is the caller's; recorded time is the server's.
    expect(movement.occurred_at.toISOString()).toBe(OCCURRED_AT);
    expect(movement.recorded_at.toISOString()).toBe(RECORDED_AT);

    // The chain the posting engine maintains — proof this went through the
    // engine rather than writing a row of its own.
    const all = await movements(chain);
    expect(all).toHaveLength(2);
    expect(movement.previous_movement_id).toBe(all[0]!.id);

    const projected = await balance(chain);
    expect(projected?.quantity_on_hand).toBe(6);
    expect(projected?.last_movement_id).toBe(movement.id);

    const [operation, ...extras] = await operations(request.operationId as string);
    expect(extras).toHaveLength(0);
    expect(operation?.operation_type).toBe(REMOVAL_OPERATION_TYPE);
    // The server owns the hash. It is a digest, never anything the client sent.
    expect(operation?.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(operation?.result_resource_type).toBe('inventory_movement');
    expect(operation?.result_resource_id).toBe(movement.id);
    expect(operation?.created_at.toISOString()).toBe(RECORDED_AT);
  });

  it('records every reason as the code it arrived as', async () => {
    for (const reason of REMOVAL_REASONS) {
      const chain = await newChain();
      await stock(chain, 5);
      await removeOk(body(chain, { quantity: 1, reason }));
      expect((await issues(chain))[0]?.reason_code, reason).toBe(reason);
    }
  });

  it('empties a shelf without refusing the request', async () => {
    // Zero is a valid resulting quantity. Removing the last of something means
    // the shelf is empty, not that the removal failed.
    const chain = await newChain();
    await stock(chain, 5);

    const result = await removeOk(body(chain, { quantity: 5 }));

    expect(result.quantityAfter).toBe(0);
    expect((await issues(chain))[0]?.quantity_after).toBe(0);

    const projected = await balance(chain);
    expect(projected?.quantity_on_hand).toBe(0);
    // A shelf drawn back down to zero keeps its pointer: the stock was there.
    expect(projected?.last_movement_id).toBe(result.movementId);
  });

  it('removes twice from the same shelf, chaining the second onto the first', async () => {
    const chain = await newChain();
    await stock(chain, 10);

    const first = await removeOk(body(chain, { quantity: 3 }));
    const second = await removeOk(body(chain, { quantity: 2, reason: 'DAMAGED' }));

    expect(first.quantityAfter).toBe(7);
    expect(second.quantityAfter).toBe(5);
    expect(second.movementId).not.toBe(first.movementId);

    const posted = await issues(chain);
    expect(posted.map((m) => m.quantity_delta)).toEqual([-3, -2]);
    expect(posted[1]?.previous_movement_id).toBe(first.movementId);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
  });

  it('interleaves with receiving on one shelf', async () => {
    // Both workflows post to the same chain through the same engine, so the
    // arithmetic has to hold across them: 10 in, 4 out, 6 in, 2 out.
    const chain = await newChain();
    await stock(chain, 10);
    await removeOk(body(chain, { quantity: 4 }));
    await stock(chain, 6);
    const last = await removeOk(body(chain, { quantity: 2 }));

    expect(last.quantityAfter).toBe(10);
    const all = await movements(chain);
    expect(all.map((m) => m.movement_type)).toEqual(['RECEIPT', 'ISSUE', 'RECEIPT', 'ISSUE']);
    expect(all.reduce((sum, m) => sum + m.quantity_delta, 0)).toBe(10);
    expect((await balance(chain))?.quantity_on_hand).toBe(10);
  });
});

describe('a removal the shelf cannot satisfy', () => {
  it('refuses it, and changes nothing at all', async () => {
    const chain = await newChain();
    await stock(chain, 4);
    const request = body(chain, { quantity: 5 });

    const { status, body: responseBody } = await remove(request);

    expect(status).toBe(422);
    expect(errorCode(responseBody)).toBe('INSUFFICIENT_STOCK');

    // Nothing partial, nothing clamped, nothing negative.
    expect(await issues(chain)).toHaveLength(0);
    expect((await balance(chain))?.quantity_on_hand).toBe(4);
    // The whole transaction rolled back, so the operation id is still free for
    // a corrected request.
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });

  it('refuses a removal from a shelf that has never held stock', async () => {
    const chain = await newChain();
    const request = body(chain, { quantity: 1 });

    const { status, body: responseBody } = await remove(request);

    expect(status).toBe(422);
    expect(errorCode(responseBody)).toBe('INSUFFICIENT_STOCK');
    expect(await movements(chain)).toHaveLength(0);
    // The engine creates a zero balance row lazily inside the transaction; the
    // rollback takes it with it. A shelf nobody ever stocked must not acquire a
    // row because somebody tried to take something off it.
    expect(await balance(chain)).toBeUndefined();
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });

  it('refuses to take stock from another location to cover a shortfall', async () => {
    // Stock at A, nothing at B. Removing from B fails, and A is untouched — the
    // requested location is the location stock leaves.
    const shelf = await newChain();
    const otherShelf: Chain = {
      variantId: shelf.variantId,
      locationId: (await newChain()).locationId,
    };
    await stock(shelf, 8);

    const { status, body: responseBody } = await remove(body(otherShelf, { quantity: 2 }));

    expect(status).toBe(422);
    expect(errorCode(responseBody)).toBe('INSUFFICIENT_STOCK');
    expect((await balance(shelf))?.quantity_on_hand).toBe(8);
    expect(await balance(otherShelf)).toBeUndefined();
    expect(await movements(otherShelf)).toHaveLength(0);
  });

  it('leaves the shelf usable afterwards', async () => {
    // A refusal is not a state. The next request, for what is actually there,
    // works normally.
    const chain = await newChain();
    await stock(chain, 4);

    expect((await remove(body(chain, { quantity: 9 }))).status).toBe(422);
    expect((await removeOk(body(chain, { quantity: 4 }))).quantityAfter).toBe(0);
  });
});

describe('retrying the same removal', () => {
  it('returns the original result and posts nothing further', async () => {
    const chain = await newChain();
    await stock(chain, 10);
    const request = body(chain, { quantity: 3 });

    const first = await removeOk(request);
    const replay = await removeOk(request);

    // The same movement, not a second one. No new id was minted, and the stock
    // came off the shelf once.
    expect(replay).toEqual(first);
    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(7);
    expect(await operations(request.operationId as string)).toHaveLength(1);
  });

  it('answers a replay after the variant has been retired', async () => {
    // A settled stock-out is a fact about the past. An item sold in the morning
    // and retired that afternoon must still answer its own retry — the stock
    // has already left the building, and a client that never saw the first
    // response would otherwise retry forever into a conflict.
    const chain = await newChain();
    await stock(chain, 6);
    const request = body(chain, { quantity: 2 });
    const first = await removeOk(request);

    await deactivateVariant(chain);

    const replay = await removeOk(request);
    expect(replay).toEqual(first);
    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(4);
  });

  it('answers a replay after the location has been closed', async () => {
    const chain = await newChain();
    await stock(chain, 6);
    const request = body(chain, { quantity: 2 });
    const first = await removeOk(request);

    await deactivateLocation(chain);

    const replay = await removeOk(request);
    expect(replay).toEqual(first);
    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(4);
  });

  it('still refuses a genuinely new removal against a variant retired since', async () => {
    // The replay lookup answers settled operations only. A *different* command
    // — a new operation id — is judged against the shelf as it is today.
    const chain = await newChain();
    await stock(chain, 6);
    await removeOk(body(chain, { quantity: 2 }));

    await deactivateVariant(chain);

    const fresh = body(chain, { quantity: 1 });
    const { status, body: responseBody } = await remove(fresh);
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(4);
    expect(await operations(fresh.operationId as string)).toHaveLength(0);
  });

  it('recognizes the same instant written with an offset', async () => {
    // 10:15Z and 05:15-05:00 are the same moment. The server normalizes before
    // hashing, so a laptop on local time retries rather than conflicts.
    const chain = await newChain();
    await stock(chain, 6);
    const request = body(chain, { quantity: 2, occurredAt: '2026-08-03T10:15:00.000Z' });

    const first = await removeOk(request);
    const replay = await removeOk({ ...request, occurredAt: '2026-08-03T05:15:00.000-05:00' });

    expect(replay).toEqual(first);
    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(4);
  });

  it('posts once when two identical retries overlap', async () => {
    // Not a second concurrency suite. This asserts the one thing removal is
    // responsible for: that it goes through the posting engine, and so inherits
    // the engine's duplicate protection rather than racing beside it.
    const chain = await newChain();
    await stock(chain, 6);
    const request = body(chain, { quantity: 2 });

    const [a, b] = await Promise.all([remove(request), remove(request)]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body).toEqual(b.body);
    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(4);
  });

  it('survives a retry that arrives after other stock has moved', async () => {
    const chain = await newChain();
    await stock(chain, 10);
    const request = body(chain, { quantity: 3 });

    const first = await removeOk(request);
    await removeOk(body(chain, { quantity: 2 }));
    const late = await removeOk(request);

    // The replay answers with what the original attempt posted — including the
    // balance as it was then, which is the operation's recorded result.
    expect(late).toEqual(first);
    expect(await issues(chain)).toHaveLength(2);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
  });

  it('answers a replay of a removal that emptied the shelf', async () => {
    // `quantityAfter: 0` is a real answer and has to survive being repeated.
    const chain = await newChain();
    await stock(chain, 4);
    const request = body(chain, { quantity: 4 });

    const first = await removeOk(request);
    expect(first.quantityAfter).toBe(0);
    expect(await removeOk(request)).toEqual(first);
    expect(await issues(chain)).toHaveLength(1);
  });
});

describe('reusing an operation id for a different command', () => {
  /**
   * Removes once, then replays the same operation id with one hashed input
   * changed, and asserts the ledger did not move.
   */
  async function conflictsWhenChanged(
    change: (chain: Chain) => Promise<Record<string, unknown>> | Record<string, unknown>,
    session: TestSession = owner,
  ): Promise<void> {
    const chain = await newChain();
    await stock(chain, 10);
    const request = body(chain, { quantity: 3 });
    const first = await removeOk(request);

    const changed = { ...request, ...(await change(chain)) };
    const { status, body: responseBody } = await remove(changed, session);

    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');

    // Nothing further was posted, and the original stands.
    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(7);
    expect(await removeOk(request)).toEqual(first);
  }

  it('refuses a different quantity', async () => {
    await conflictsWhenChanged(() => ({ quantity: 4 }));
  });

  it('refuses a different variant', async () => {
    await conflictsWhenChanged(async () => ({ variantId: (await newChain()).variantId }));
  });

  it('refuses a different location', async () => {
    await conflictsWhenChanged(async () => ({ locationId: (await newChain()).locationId }));
  });

  it('refuses a different reason', async () => {
    // Three bottles sold and three bottles broken are not the same business
    // fact, however identical the balance ends up looking.
    await conflictsWhenChanged(() => ({ reason: 'DAMAGED' }));
  });

  it('refuses a different business time', async () => {
    await conflictsWhenChanged(() => ({ occurredAt: '2026-08-03T11:00:00.000Z' }));
  });

  it('refuses the same command from a different person', async () => {
    // Who took the stock off the shelf is part of what happened, so it is in
    // the hash. The actor is not in the body at all — it changes because the
    // session does.
    await conflictsWhenChanged(() => ({}), manager);
  });

  it('refuses an id already used for a receipt of the same size', async () => {
    // Booking in three and selling three are different commands, and the
    // workflow is in the hash. Reusing one id across them must conflict rather
    // than answer with the wrong movement.
    const chain = await newChain();
    const operationId = newId();
    const shared = {
      operationId,
      variantId: chain.variantId,
      locationId: chain.locationId,
      quantity: 3,
      occurredAt: OCCURRED_AT,
    };

    expect((await post('/api/inventory/receive', shared)).status).toBe(201);

    const { status, body: responseBody } = await remove({ ...shared, reason: 'SOLD' });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');

    expect(await issues(chain)).toHaveLength(0);
    expect((await balance(chain))?.quantity_on_hand).toBe(3);
  });

  it('reports the id conflict, not the inactive variant, when both are true', async () => {
    // Two `409`s could apply here. The right one names the id: one operation id
    // used for two different commands is a conflict about the command, and
    // answering "this item is inactive" would send somebody to fix the wrong
    // thing — and would change its answer the day the item came back.
    const chain = await newChain();
    await stock(chain, 10);
    const request = body(chain, { quantity: 3 });
    const first = await removeOk(request);

    await deactivateVariant(chain);

    const { status, body: responseBody } = await remove({ ...request, quantity: 4 });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');

    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(7);
    // And the genuine retry still answers, retired variant and all.
    expect(await removeOk(request)).toEqual(first);
  });

  it('reports the id conflict, not the closed location, when both are true', async () => {
    const chain = await newChain();
    await stock(chain, 10);
    const request = body(chain, { quantity: 3 });
    await removeOk(request);

    await deactivateLocation(chain);

    const { status, body: responseBody } = await remove({ ...request, reason: 'INTERNAL_USE' });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');

    expect(await issues(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(7);
  });

  it('reports the id conflict rather than a shortfall', async () => {
    // The changed body asks for more than the shelf holds. It is still refused
    // as a reused id: the command was never validated, let alone attempted.
    const chain = await newChain();
    await stock(chain, 5);
    const request = body(chain, { quantity: 2 });
    await removeOk(request);

    const { status, body: responseBody } = await remove({ ...request, quantity: 99 });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');
    expect((await balance(chain))?.quantity_on_hand).toBe(3);
  });
});

describe('who may remove stock', () => {
  it('refuses an anonymous request', async () => {
    const chain = await newChain();
    await stock(chain, 5);
    const { status, body: responseBody } = await remove(body(chain), null);

    expect(status).toBe(401);
    expect(errorCode(responseBody)).toBe('UNAUTHENTICATED');
    expect(await issues(chain)).toHaveLength(0);
  });

  it('refuses an anonymous malformed request before it validates it', async () => {
    // Authentication runs in an `onRequest` hook, before the body is parsed. An
    // unusable request from nobody is still `401` — answering `400` would tell
    // an anonymous caller which fields the endpoint expects.
    const anonymousGarbage = await remove({ quantity: -1, nonsense: true }, null);
    expect(anonymousGarbage.status).toBe(401);
    expect(errorCode(anonymousGarbage.body)).toBe('UNAUTHENTICATED');

    const anonymousBrokenJson = await remove('{ not json', null);
    expect(anonymousBrokenJson.status).toBe(401);
    expect(errorCode(anonymousBrokenJson.body)).toBe('UNAUTHENTICATED');
  });

  it('lets an ordinary employee record what left, on the default grants', async () => {
    // The operating model this capability exists for. Stock leaves the shelf
    // whether or not the system lets the person at the counter say so.
    const employee = await createTestSession(db.pool, { role: 'EMPLOYEE' });
    const chain = await newChain();
    await stock(chain, 6);

    const result = await removeOk(body(chain, { quantity: 2 }), employee);

    expect(result.quantityAfter).toBe(4);
    expect((await issues(chain))[0]?.user_id).toBe(employee.user.id);
  });

  it('refuses somebody whose role lost the capability, and lets them back in once regranted', async () => {
    const employee = await createTestSession(db.pool, {
      role: 'EMPLOYEE',
      username: 'employee.two',
    });
    const chain = await newChain();
    await stock(chain, 6);

    await db.pool.query(
      `DELETE FROM role_capabilities WHERE role = 'EMPLOYEE' AND capability = 'inventory.remove'`,
    );

    const refused = await app.inject({
      method: 'POST',
      url: '/api/inventory/remove',
      headers: { 'content-type': 'application/json' },
      cookies: employee.cookies,
      payload: JSON.stringify(body(chain, { quantity: 1 })),
    });
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused.json())).toBe('FORBIDDEN');
    expect(await issues(chain)).toHaveLength(0);

    // A denial is not a session problem. Nothing clears the cookie, and the
    // same session still reads stock — being told "not you" must not make
    // somebody sign in again to find out they still cannot.
    expect(refused.headers['set-cookie']).toBeUndefined();
    const stillSignedIn = await app.inject({
      method: 'GET',
      url: '/api/inventory/locations',
      cookies: employee.cookies,
    });
    expect(stillSignedIn.statusCode).toBe(200);

    await db.pool.query(
      `INSERT INTO role_capabilities (role, capability) VALUES ('EMPLOYEE', 'inventory.remove')`,
    );

    const granted = await removeOk(body(chain, { quantity: 1 }), employee);
    expect(granted.quantityAfter).toBe(5);
  });

  it('does not accept inventory.receive in place of inventory.remove', async () => {
    // The two are different permissions over different acts, and holding one
    // must not open the other's door.
    const employee = await createTestSession(db.pool, {
      role: 'EMPLOYEE',
      username: 'employee.three',
    });
    const chain = await newChain();
    await stock(chain, 6);

    await db.pool.query(
      `DELETE FROM role_capabilities WHERE role = 'EMPLOYEE' AND capability = 'inventory.remove'`,
    );
    try {
      const { rows } = await db.pool.query<{ capability: string }>(
        `SELECT capability FROM role_capabilities WHERE role = 'EMPLOYEE' ORDER BY capability`,
      );
      expect(rows.map((r) => r.capability)).toEqual([
        'catalog.read',
        'inventory.read',
        'inventory.receive',
      ]);

      const { status } = await remove(body(chain, { quantity: 1 }), employee);
      expect(status).toBe(403);
      expect(await issues(chain)).toHaveLength(0);
    } finally {
      await db.pool.query(
        `INSERT INTO role_capabilities (role, capability) VALUES ('EMPLOYEE', 'inventory.remove')`,
      );
    }
  });

  it('attributes the movement to the session even when the body names somebody else', async () => {
    const chain = await newChain();
    await stock(chain, 6);

    // The strict schema refuses the attempt outright rather than ignoring it.
    const forged = await remove(body(chain, { userId: manager.user.id }));
    expect(forged.status).toBe(400);
    expect(errorCode(forged.body)).toBe('VALIDATION_FAILED');
    expect(await issues(chain)).toHaveLength(0);

    // And the movement that does get posted carries the signed-in person.
    await removeOk(body(chain, { quantity: 1 }), manager);
    expect((await issues(chain))[0]?.user_id).toBe(manager.user.id);
  });
});

describe('what stock may be removed from', () => {
  it('refuses a variant that does not exist', async () => {
    const chain = await newChain();
    const { status, body: responseBody } = await remove(body(chain, { variantId: newId() }));

    expect(status).toBe(404);
    expect(errorCode(responseBody)).toBe('NOT_FOUND');
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses a variant that is no longer active', async () => {
    const chain = await newChain({ variantActive: false });
    const request = body(chain);
    const { status, body: responseBody } = await remove(request);

    // The variant plainly exists — a 404 would send somebody holding the last
    // two bottles looking for a typo instead of for whoever retired the item.
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    expect(await movements(chain)).toHaveLength(0);
    expect(await balance(chain)).toBeUndefined();
    // Business validation ran before the operation was claimed, so the id is
    // still free for a corrected request.
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });

  it('refuses a location that does not exist', async () => {
    const chain = await newChain();
    const { status, body: responseBody } = await remove(body(chain, { locationId: newId() }));

    expect(status).toBe(404);
    expect(errorCode(responseBody)).toBe('NOT_FOUND');
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses a location that is no longer active', async () => {
    const chain = await newChain({ locationActive: false });
    const request = body(chain);
    const { status, body: responseBody } = await remove(request);

    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    expect(await movements(chain)).toHaveLength(0);
    expect(await balance(chain)).toBeUndefined();
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });
});

describe('what a removal request may say', () => {
  /** Asserts a body is refused as a 400 and that it wrote nothing. */
  async function rejects(chain: Chain, payload: unknown): Promise<void> {
    const { status, body: responseBody } = await remove(payload);
    expect(status, JSON.stringify(responseBody)).toBe(400);
    expect(errorCode(responseBody)).toBe('VALIDATION_FAILED');
    expect(await issues(chain)).toHaveLength(0);
  }

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 2.5],
    ['a string', '4'],
    ['null', null],
    ['over the integer ceiling', 2_147_483_648],
  ])('refuses a %s quantity', async (_label, quantity) => {
    const chain = await newChain();
    await stock(chain, 6);
    await rejects(chain, body(chain, { quantity }));
  });

  it('refuses a missing quantity', async () => {
    const chain = await newChain();
    const payload = body(chain);
    delete payload.quantity;
    await rejects(chain, payload);
  });

  it('refuses a negative quantity rather than reading it as the delta', async () => {
    // A caller that could send `-5` would be describing the ledger's
    // representation rather than the business event — and a workflow that
    // accepted both spellings could not tell one retry from another.
    const chain = await newChain();
    await stock(chain, 6);
    await rejects(chain, body(chain, { quantity: -5 }));
    expect((await balance(chain))?.quantity_on_hand).toBe(6);
  });

  it.each([
    ['unknown', 'STOLEN'],
    ['lower-cased', 'sold'],
    ['a translated label', 'Vandi'],
    ['blank', ''],
    ['free text', 'the customer took two'],
    ['null', null],
  ])('refuses a %s reason', async (_label, reason) => {
    const chain = await newChain();
    await stock(chain, 6);
    await rejects(chain, body(chain, { reason }));
  });

  it('refuses a missing reason', async () => {
    // The type says stock left; the reason says whether that was trade or loss.
    // A removal without one is half a record, and the ledger refuses it too.
    const chain = await newChain();
    const payload = body(chain);
    delete payload.reason;
    await rejects(chain, payload);
  });

  it.each([
    ['malformed', 'yesterday'],
    ['date-only', '2026-08-03'],
    ['impossible', '2026-02-31T10:00:00.000Z'],
  ])('refuses a %s timestamp', async (_label, occurredAt) => {
    const chain = await newChain();
    await rejects(chain, body(chain, { occurredAt }));
  });

  it('refuses a missing timestamp', async () => {
    const chain = await newChain();
    const payload = body(chain);
    delete payload.occurredAt;
    await rejects(chain, payload);
  });

  it('refuses an operation id that is not a uuid', async () => {
    const chain = await newChain();
    await rejects(chain, body(chain, { operationId: 'retry-1' }));
  });

  it('refuses malformed JSON', async () => {
    const chain = await newChain();
    const { status, body: responseBody } = await remove('{ "quantity": ');
    expect(status).toBe(400);
    expect(errorCode(responseBody)).toBe('VALIDATION_FAILED');
    expect(await issues(chain)).toHaveLength(0);
  });

  it.each([
    'userId',
    'movementId',
    'movementType',
    'quantityDelta',
    'recordedAt',
    'quantityBefore',
    'quantityAfter',
    'previousMovementId',
    'requestHash',
    'operationType',
    'reasonCode',
    'note',
  ])('refuses a request that tries to supply %s', async (field) => {
    // Every one of these is the server's. `reasonCode` is refused for a subtler
    // reason than the rest: it is the ledger's column name, and the public
    // field is `reason`. A client that could set the column directly could
    // write a reason no screen offers and no report counts.
    const chain = await newChain();
    await rejects(chain, body(chain, { [field]: 'anything' }));
  });

  it('preserves a valid business time exactly as given', async () => {
    const chain = await newChain();
    await stock(chain, 6);
    const occurredAt = '2026-07-29T16:45:12.345Z';
    await removeOk(body(chain, { quantity: 1, occurredAt }));

    const [movement] = await issues(chain);
    expect(movement?.occurred_at.toISOString()).toBe(occurredAt);
    // And the server's own timestamp is untouched by it.
    expect(movement?.recorded_at.toISOString()).toBe(RECORDED_AT);
  });
});

describe('two removals racing for the same stock', () => {
  it('lets exactly one through and refuses the other with a shortfall', async () => {
    // The scenario the stock floor exists for, staged through HTTP so it proves
    // the *workflow* delegates rather than checking the balance itself. The
    // overlap is forced and verified — a separate transaction holds the balance
    // row, both requests are launched, and PostgreSQL is asked to confirm that
    // both are blocked on a lock before it is released. Without that, the two
    // might simply run one after another and pass for the wrong reason.
    const chain = await newChain();
    await stock(chain, 10);

    const first = body(chain, { quantity: 7 });
    const second = body(chain, { quantity: 7, reason: 'DAMAGED' });

    const settled = await runConcurrentlyBehindLock(db.pool, lockBalanceRow(chain), [
      () => remove(first),
      () => remove(second),
    ]);

    // `app.inject` resolves whatever the status, so both settle; the answers
    // are in the statuses.
    const answers = settled.map((outcome) => {
      expect(outcome.status).toBe('fulfilled');
      return (outcome as PromiseFulfilledResult<Injected>).value;
    });

    expect(answers.map((a) => a.status).sort()).toEqual([201, 422]);
    const loser = answers.find((a) => a.status === 422)!;
    expect(errorCode(loser.body)).toBe('INSUFFICIENT_STOCK');

    // 10 - 7, and exactly one withdrawal was appended.
    expect((await balance(chain))?.quantity_on_hand).toBe(3);
    const posted = await issues(chain);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.quantity_delta).toBe(-7);
    expect(posted[0]?.quantity_before).toBe(10);
    expect(posted[0]?.quantity_after).toBe(3);

    // The loser left nothing durable behind: no operation, no movement, no
    // trace in the projection. Which command lost is read back rather than
    // assumed — that would be an assumption about scheduling.
    const winnerId = posted[0]!.operation_id;
    const lostRequest = winnerId === first.operationId ? second : first;
    expect(await operations(lostRequest.operationId as string)).toHaveLength(0);

    // And the shelf still works: 3 is there, and 3 can be taken.
    expect((await removeOk(body(chain, { quantity: 3 }))).quantityAfter).toBe(0);
  });
});
