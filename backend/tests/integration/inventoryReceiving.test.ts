import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveStockResponseSchema, type ErrorBody } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { RECEIVING_OPERATION_TYPE } from '../../src/modules/inventory/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { newId } from '../../src/platform/ids/uuidv7.js';
import { createTestSession, type TestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `POST /api/inventory/receive`, end to end, against real PostgreSQL.
 *
 * The point of this suite is the database, not the status codes. Receiving is
 * the first workflow that writes to the ledger, so almost every assertion here
 * reads back the rows that were actually written — the operation, the movement,
 * the balance — and the failure cases assert that *nothing* was written. A
 * `201` proves the route answered; only the movement row proves the stock moved
 * once, with the right quantity, attributed to the right person.
 *
 * Movements can never be deleted, so each test that posts works on its own
 * freshly created (variant, location) chain.
 */

/** Server time, from the injected clock. Inside the test session's lifetime. */
const RECORDED_AT = '2026-08-03T12:00:00.000Z';
/** Business time: the delivery arrived before it was entered. */
const OCCURRED_AT = '2026-08-03T08:30:00.000Z';

let db: TestDatabase;
let app: FastifyInstance;
/** Holds every capability, including `inventory.receive`. */
let owner: TestSession;
/** A second person who may also receive — used to change the hashed actor. */
let manager: TestSession;

interface Chain {
  variantId: string;
  locationId: string;
}

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `EKN-R${skuCounter.toString().padStart(7, '0')}`;
}

/** A fresh product, variant, and location: one isolated movement chain. */
async function newChain(
  options: { variantActive?: boolean; locationActive?: boolean } = {},
): Promise<Chain> {
  const productId = newId();
  await db.pool.query(
    `INSERT INTO products (id, name, created_at, updated_at)
     VALUES ($1, 'Receiving fixture', $2, $2)`,
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
     VALUES ($1, 'Receiving fixture location', false, $2, $3, $3)`,
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

/** A well-formed receiving body, with anything a test cares about overridden. */
function body(chain: Chain, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: newId(),
    variantId: chain.variantId,
    locationId: chain.locationId,
    quantity: 5,
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

interface Injected {
  status: number;
  body: unknown;
}

async function receive(payload: unknown, session: TestSession | null = owner): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/inventory/receive',
    headers: { 'content-type': 'application/json' },
    ...(session ? { cookies: session.cookies } : {}),
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { status: response.statusCode, body: response.json() };
}

/** Posts a body that is expected to succeed, and returns the parsed result. */
async function receiveOk(payload: unknown, session: TestSession = owner) {
  const { status, body: responseBody } = await receive(payload, session);
  expect(status, JSON.stringify(responseBody)).toBe(201);
  return receiveStockResponseSchema.parse(responseBody);
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

describe('receiving stock that arrived', () => {
  it('records one movement, moves the balance, and completes the operation', async () => {
    const chain = await newChain();
    const request = body(chain, { quantity: 7 });

    const result = await receiveOk(request);

    // The response is the shared contract and nothing more.
    expect(Object.keys(result).sort()).toEqual(['movementId', 'operationId', 'quantityAfter']);
    expect(result.operationId).toBe(request.operationId);
    expect(result.quantityAfter).toBe(7);

    const posted = await movements(chain);
    expect(posted).toHaveLength(1);
    const movement = posted[0]!;

    expect(movement.id).toBe(result.movementId);
    expect(movement.variant_id).toBe(chain.variantId);
    expect(movement.location_id).toBe(chain.locationId);
    // The workflow chose the type and the sign, not the request.
    expect(movement.movement_type).toBe('RECEIPT');
    expect(movement.quantity_delta).toBe(7);
    expect(movement.quantity_before).toBe(0);
    expect(movement.quantity_after).toBe(7);
    expect(movement.previous_movement_id).toBeNull();
    expect(movement.reverses_movement_id).toBeNull();
    expect(movement.reason_code).toBeNull();
    expect(movement.note).toBeNull();

    // Attribution is the session's, and the request never mentioned a user.
    expect(movement.user_id).toBe(owner.user.id);

    // Business time is the caller's; recorded time is the server's.
    expect(movement.occurred_at.toISOString()).toBe(OCCURRED_AT);
    expect(movement.recorded_at.toISOString()).toBe(RECORDED_AT);

    const projected = await balance(chain);
    expect(projected?.quantity_on_hand).toBe(7);
    expect(projected?.last_movement_id).toBe(movement.id);

    const [operation, ...extras] = await operations(request.operationId as string);
    expect(extras).toHaveLength(0);
    expect(operation?.operation_type).toBe(RECEIVING_OPERATION_TYPE);
    // The server owns the hash. It is a digest, never anything the client sent.
    expect(operation?.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(operation?.result_resource_type).toBe('inventory_movement');
    expect(operation?.result_resource_id).toBe(movement.id);
    expect(operation?.created_at.toISOString()).toBe(RECORDED_AT);
  });

  it('adds to a chain that already holds stock', async () => {
    const chain = await newChain();
    const first = await receiveOk(body(chain, { quantity: 4 }));
    const second = await receiveOk(body(chain, { quantity: 6 }));

    expect(second.quantityAfter).toBe(10);
    expect(second.movementId).not.toBe(first.movementId);

    const posted = await movements(chain);
    expect(posted).toHaveLength(2);
    expect(posted[1]?.quantity_before).toBe(4);
    expect(posted[1]?.quantity_after).toBe(10);
    // The chain the posting engine maintains — proof the workflow went through
    // the engine rather than writing a row of its own.
    expect(posted[1]?.previous_movement_id).toBe(first.movementId);

    const projected = await balance(chain);
    expect(projected?.quantity_on_hand).toBe(10);
    expect(projected?.last_movement_id).toBe(second.movementId);
  });

  it('keeps two chains independent', async () => {
    const shelf = await newChain();
    const otherShelf = await newChain();

    await receiveOk(body(shelf, { quantity: 3 }));
    await receiveOk(body(otherShelf, { quantity: 9 }));

    expect((await balance(shelf))?.quantity_on_hand).toBe(3);
    expect((await balance(otherShelf))?.quantity_on_hand).toBe(9);
  });
});

describe('retrying the same command', () => {
  it('returns the original result and posts nothing further', async () => {
    const chain = await newChain();
    const request = body(chain, { quantity: 5 });

    const first = await receiveOk(request);
    const replay = await receiveOk(request);

    // The same movement, not a second one. No new id was minted.
    expect(replay).toEqual(first);

    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
    expect(await operations(request.operationId as string)).toHaveLength(1);
  });

  it('answers a replay after the variant has been retired', async () => {
    // A settled receipt is a fact about the past. What happened to the item
    // afterwards cannot make that afternoon's delivery unanswerable — a client
    // that never saw the first response would otherwise retry forever into a
    // conflict, and the stock it is asking about is already on the shelf.
    const chain = await newChain();
    const request = body(chain, { quantity: 5 });
    const first = await receiveOk(request);

    await deactivateVariant(chain);

    const replay = await receiveOk(request);
    expect(replay.movementId).toBe(first.movementId);
    expect(replay.quantityAfter).toBe(first.quantityAfter);
    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
    expect(await operations(request.operationId as string)).toHaveLength(1);
  });

  it('answers a replay after the location has been closed', async () => {
    const chain = await newChain();
    const request = body(chain, { quantity: 8 });
    const first = await receiveOk(request);

    await deactivateLocation(chain);

    const replay = await receiveOk(request);
    expect(replay.movementId).toBe(first.movementId);
    expect(replay.quantityAfter).toBe(8);
    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(8);
  });

  it('still refuses a genuinely new command against a variant retired since', async () => {
    // The replay lookup answers settled operations only. A *different* command
    // — a new operation id — is judged against the shelf as it is today.
    const chain = await newChain();
    await receiveOk(body(chain, { quantity: 5 }));

    await deactivateVariant(chain);

    const fresh = body(chain, { quantity: 2 });
    const { status, body: responseBody } = await receive(fresh);
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
    expect(await operations(fresh.operationId as string)).toHaveLength(0);
  });

  it('recognizes the same instant written with an offset', async () => {
    // 08:30Z and 03:30-05:00 are the same moment. The server normalizes before
    // hashing, so a laptop on local time retries rather than conflicts.
    const chain = await newChain();
    const request = body(chain, { quantity: 5, occurredAt: '2026-08-03T08:30:00.000Z' });

    const first = await receiveOk(request);
    const replay = await receiveOk({ ...request, occurredAt: '2026-08-03T03:30:00.000-05:00' });

    expect(replay).toEqual(first);
    expect(await movements(chain)).toHaveLength(1);
  });

  it('posts once when two identical retries overlap', async () => {
    // Not a second concurrency suite — `inventoryPostingConcurrency.test.ts`
    // owns that. This asserts the one thing receiving is responsible for: that
    // it goes through the posting engine, and so inherits the engine's
    // duplicate protection rather than racing beside it.
    const chain = await newChain();
    const request = body(chain, { quantity: 5 });

    const [a, b] = await Promise.all([receive(request), receive(request)]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body).toEqual(b.body);
    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
  });

  it('survives a retry that arrives after other stock has moved', async () => {
    const chain = await newChain();
    const request = body(chain, { quantity: 5 });

    const first = await receiveOk(request);
    await receiveOk(body(chain, { quantity: 2 }));
    const late = await receiveOk(request);

    // The replay answers with what the original attempt posted — including the
    // balance as it was then, which is the operation's recorded result.
    expect(late).toEqual(first);
    expect(await movements(chain)).toHaveLength(2);
    expect((await balance(chain))?.quantity_on_hand).toBe(7);
  });
});

describe('reusing an operation id for a different command', () => {
  /**
   * Receives once, then replays the same operation id with one hashed input
   * changed, and asserts the ledger did not move.
   */
  async function conflictsWhenChanged(
    change: (chain: Chain) => Promise<Record<string, unknown>> | Record<string, unknown>,
    session: TestSession = owner,
  ): Promise<void> {
    const chain = await newChain();
    const request = body(chain, { quantity: 5 });
    const first = await receiveOk(request);

    const changed = { ...request, ...(await change(chain)) };
    const { status, body: responseBody } = await receive(changed, session);

    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');

    // Nothing was posted, on either chain, and the original stands.
    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
    expect(await receiveOk(request)).toEqual(first);
  }

  it('refuses a different quantity', async () => {
    await conflictsWhenChanged(() => ({ quantity: 6 }));
  });

  it('refuses a different variant', async () => {
    await conflictsWhenChanged(async () => ({ variantId: (await newChain()).variantId }));
  });

  it('refuses a different location', async () => {
    await conflictsWhenChanged(async () => ({ locationId: (await newChain()).locationId }));
  });

  it('refuses a different business time', async () => {
    await conflictsWhenChanged(() => ({ occurredAt: '2026-08-03T09:30:00.000Z' }));
  });

  it('refuses the same command from a different person', async () => {
    // Who received the stock is part of what happened, so it is in the hash.
    // The actor is not in the body at all — it changes because the session does.
    await conflictsWhenChanged(() => ({}), manager);
  });

  it('leaves nothing behind on the other chain either', async () => {
    const chain = await newChain();
    const elsewhere = await newChain();
    const request = body(chain, { quantity: 5 });
    await receiveOk(request);

    const { status } = await receive({ ...request, variantId: elsewhere.variantId });
    expect(status).toBe(409);

    expect(await movements(elsewhere)).toHaveLength(0);
    expect(await balance(elsewhere)).toBeUndefined();
  });

  it('reports the id conflict, not the inactive variant, when both are true', async () => {
    // Two `409`s could apply here. The right one names the id: one operation id
    // used for two different commands is a conflict about the command, and
    // answering "this item is inactive" would send somebody to fix the wrong
    // thing — and would change its answer the day the item came back.
    const chain = await newChain();
    const request = body(chain, { quantity: 5 });
    const first = await receiveOk(request);

    await deactivateVariant(chain);

    const { status, body: responseBody } = await receive({ ...request, quantity: 6 });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');

    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
    // And the genuine retry still answers, retired variant and all.
    expect(await receiveOk(request)).toEqual(first);
  });

  it('reports the id conflict, not the closed location, when both are true', async () => {
    const chain = await newChain();
    const request = body(chain, { quantity: 5 });
    await receiveOk(request);

    await deactivateLocation(chain);

    const { status, body: responseBody } = await receive({
      ...request,
      occurredAt: '2026-08-03T09:45:00.000Z',
    });
    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('OPERATION_REPLAYED_WITH_DIFFERENT_BODY');

    expect(await movements(chain)).toHaveLength(1);
    expect((await balance(chain))?.quantity_on_hand).toBe(5);
  });
});

describe('who may receive', () => {
  it('refuses an anonymous request', async () => {
    const chain = await newChain();
    const { status, body: responseBody } = await receive(body(chain), null);

    expect(status).toBe(401);
    expect(errorCode(responseBody)).toBe('UNAUTHENTICATED');
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses an anonymous malformed request before it validates it', async () => {
    // Authentication runs in an `onRequest` hook, before the body is parsed. An
    // unusable request from nobody is still `401` — answering `400` would tell
    // an anonymous caller which fields the endpoint expects.
    const anonymousGarbage = await receive({ quantity: -1, nonsense: true }, null);
    expect(anonymousGarbage.status).toBe(401);
    expect(errorCode(anonymousGarbage.body)).toBe('UNAUTHENTICATED');

    const anonymousBrokenJson = await receive('{ not json', null);
    expect(anonymousBrokenJson.status).toBe(401);
    expect(errorCode(anonymousBrokenJson.body)).toBe('UNAUTHENTICATED');
  });

  it('refuses a signed-in person who lacks inventory.receive, and lets them in once granted', async () => {
    const employee = await createTestSession(db.pool, { role: 'EMPLOYEE' });
    const chain = await newChain();

    await db.pool.query(
      `DELETE FROM role_capabilities WHERE role = 'EMPLOYEE' AND capability = 'inventory.receive'`,
    );

    const refused = await app.inject({
      method: 'POST',
      url: '/api/inventory/receive',
      headers: { 'content-type': 'application/json' },
      cookies: employee.cookies,
      payload: JSON.stringify(body(chain)),
    });
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused.json())).toBe('FORBIDDEN');
    expect(await movements(chain)).toHaveLength(0);

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
      `INSERT INTO role_capabilities (role, capability) VALUES ('EMPLOYEE', 'inventory.receive')`,
    );

    const granted = await receiveOk(body(chain, { quantity: 2 }), employee);
    expect(granted.quantityAfter).toBe(2);
    const posted = await movements(chain);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.user_id).toBe(employee.user.id);
  });

  it('attributes the movement to the session even when the body names somebody else', async () => {
    const chain = await newChain();

    // The strict schema refuses the attempt outright rather than ignoring it.
    const forged = await receive(body(chain, { userId: manager.user.id }));
    expect(forged.status).toBe(400);
    expect(errorCode(forged.body)).toBe('VALIDATION_FAILED');
    expect(await movements(chain)).toHaveLength(0);

    // And the movement that does get posted carries the signed-in person.
    await receiveOk(body(chain), manager);
    expect((await movements(chain))[0]?.user_id).toBe(manager.user.id);
  });
});

describe('what may be received', () => {
  it('refuses a variant that does not exist', async () => {
    const chain = await newChain();
    const missing = newId();
    const { status, body: responseBody } = await receive(body(chain, { variantId: missing }));

    expect(status).toBe(404);
    expect(errorCode(responseBody)).toBe('NOT_FOUND');
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses a variant that is no longer active', async () => {
    const chain = await newChain({ variantActive: false });
    const request = body(chain);
    const { status, body: responseBody } = await receive(request);

    // The variant plainly exists — a 404 would send somebody holding a delivery
    // looking for a typo instead of for whoever retired the item.
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
    const { status, body: responseBody } = await receive(body(chain, { locationId: newId() }));

    expect(status).toBe(404);
    expect(errorCode(responseBody)).toBe('NOT_FOUND');
    expect(await movements(chain)).toHaveLength(0);
  });

  it('refuses a location that is no longer active', async () => {
    const chain = await newChain({ locationActive: false });
    const request = body(chain);
    const { status, body: responseBody } = await receive(request);

    expect(status).toBe(409);
    expect(errorCode(responseBody)).toBe('CONFLICT');
    expect(await movements(chain)).toHaveLength(0);
    expect(await balance(chain)).toBeUndefined();
    expect(await operations(request.operationId as string)).toHaveLength(0);
  });
});

describe('what a request may say', () => {
  /** Asserts a body is refused as a 400 and that it wrote nothing. */
  async function rejects(chain: Chain, payload: unknown): Promise<void> {
    const { status, body: responseBody } = await receive(payload);
    expect(status, JSON.stringify(responseBody)).toBe(400);
    expect(errorCode(responseBody)).toBe('VALIDATION_FAILED');
    expect(await movements(chain)).toHaveLength(0);
  }

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 2.5],
    ['a string', '4'],
    ['null', null],
  ])('refuses a %s quantity', async (_label, quantity) => {
    const chain = await newChain();
    await rejects(chain, body(chain, { quantity }));
  });

  it('refuses a missing quantity', async () => {
    const chain = await newChain();
    const payload = body(chain);
    delete payload.quantity;
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
    const { status, body: responseBody } = await receive('{ "quantity": ');
    expect(status).toBe(400);
    expect(errorCode(responseBody)).toBe('VALIDATION_FAILED');
    expect(await movements(chain)).toHaveLength(0);
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
    // Every one of these is the server's. Rejecting rather than ignoring is
    // what stops a client discovering that sending one is harmless.
    const chain = await newChain();
    await rejects(chain, body(chain, { [field]: 'anything' }));
  });

  it('preserves a valid business time exactly as given', async () => {
    const chain = await newChain();
    const occurredAt = '2026-07-29T16:45:12.345Z';
    await receiveOk(body(chain, { occurredAt }));

    const [movement] = await movements(chain);
    expect(movement?.occurred_at.toISOString()).toBe(occurredAt);
    // And the server's own timestamp is untouched by it.
    expect(movement?.recorded_at.toISOString()).toBe(RECORDED_AT);
  });
});
