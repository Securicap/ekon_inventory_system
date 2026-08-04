import { describe, expect, it } from 'vitest';
import {
  MAX_MOVEMENT_QUANTITY,
  occurredAtSchema,
  receiveStockRequestSchema,
  receiveStockResponseSchema,
} from '../src/index.js';

/**
 * The receiving wire contract. What this file mostly asserts is what the
 * request *refuses*: every field the server owns is rejected rather than
 * ignored, so a client cannot discover that sending one is harmless and come to
 * depend on it.
 */

const VARIANT_ID = '0198f0a0-0000-7000-8000-000000000001';
const LOCATION_ID = '0198f0a0-0000-7000-8000-000000000002';
const OPERATION_ID = '0198f0a0-0000-7000-8000-000000000003';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    variantId: VARIANT_ID,
    locationId: LOCATION_ID,
    quantity: 12,
    occurredAt: '2026-08-04T10:00:00.000Z',
    ...overrides,
  };
}

describe('receive-stock request', () => {
  it('accepts the four business fields and the operation id', () => {
    const parsed = receiveStockRequestSchema.parse(request());
    expect(parsed).toEqual({
      operationId: OPERATION_ID,
      variantId: VARIANT_ID,
      locationId: LOCATION_ID,
      quantity: 12,
      occurredAt: '2026-08-04T10:00:00.000Z',
    });
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
    'reasonCode',
    'note',
  ])('refuses a client-supplied %s', (field) => {
    // Each of these is the server's to decide. Rejecting is the point: a body
    // that carries one and still succeeds teaches the client it may.
    const parsed = receiveStockRequestSchema.safeParse(request({ [field]: 'anything' }));
    expect(parsed.success).toBe(false);
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
    ['a string', '4'],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['beyond the ledger ceiling', MAX_MOVEMENT_QUANTITY + 1],
  ])('refuses a %s quantity', (_label, quantity) => {
    expect(receiveStockRequestSchema.safeParse(request({ quantity })).success).toBe(false);
  });

  it('accepts the largest quantity the ledger columns can hold', () => {
    expect(
      receiveStockRequestSchema.safeParse(request({ quantity: MAX_MOVEMENT_QUANTITY })).success,
    ).toBe(true);
  });

  it('requires every field', () => {
    for (const field of ['operationId', 'variantId', 'locationId', 'quantity', 'occurredAt']) {
      const body = request();
      delete body[field];
      expect(receiveStockRequestSchema.safeParse(body).success, `${field} was optional`).toBe(
        false,
      );
    }
  });

  it('refuses identifiers that are not uuids', () => {
    expect(receiveStockRequestSchema.safeParse(request({ variantId: 'nope' })).success).toBe(false);
    expect(receiveStockRequestSchema.safeParse(request({ locationId: '42' })).success).toBe(false);
    expect(receiveStockRequestSchema.safeParse(request({ operationId: '' })).success).toBe(false);
  });
});

describe('business timestamp', () => {
  it('accepts UTC and an offset', () => {
    expect(occurredAtSchema.safeParse('2026-08-04T10:00:00.000Z').success).toBe(true);
    expect(occurredAtSchema.safeParse('2026-08-04T05:00:00-05:00').success).toBe(true);
  });

  it('refuses a malformed timestamp', () => {
    for (const value of ['yesterday', '2026-08-04', '04/08/2026', '2026-08-04 10:00:00', '']) {
      expect(occurredAtSchema.safeParse(value).success, `${value} was accepted`).toBe(false);
    }
  });

  it('refuses a date that does not exist', () => {
    // `new Date('2026-02-31')` rolls forward to 3 March rather than failing, so
    // a typo would be stored as a real — and wrong — business date.
    expect(occurredAtSchema.safeParse('2026-02-31T10:00:00Z').success).toBe(false);
    expect(occurredAtSchema.safeParse('2025-02-29T10:00:00Z').success).toBe(false);
    expect(occurredAtSchema.safeParse('2026-04-31T10:00:00Z').success).toBe(false);
  });

  it('accepts a leap day in a leap year', () => {
    expect(occurredAtSchema.safeParse('2028-02-29T10:00:00Z').success).toBe(true);
  });

  it('does not refuse a future business time', () => {
    // A shop laptop whose clock is a few minutes fast must not be blocked from
    // booking in a delivery that is physically on the counter.
    expect(occurredAtSchema.safeParse('2099-01-01T00:00:00Z').success).toBe(true);
  });
});

describe('receive-stock response', () => {
  it('is the command, the movement it produced, and the new balance', () => {
    const parsed = receiveStockResponseSchema.parse({
      operationId: OPERATION_ID,
      movementId: VARIANT_ID,
      quantityAfter: 12,
    });
    expect(Object.keys(parsed).sort()).toEqual(['movementId', 'operationId', 'quantityAfter']);
  });

  it('exposes no ledger internals', () => {
    // A ledger internal in a response body is one a client will start reading,
    // and then it is a contract.
    const withInternals = {
      operationId: OPERATION_ID,
      movementId: VARIANT_ID,
      quantityAfter: 12,
      previousMovementId: LOCATION_ID,
      quantityBefore: 0,
      requestHash: 'a'.repeat(64),
    };
    expect(receiveStockResponseSchema.safeParse(withInternals).success).toBe(false);
  });

  it('refuses a negative balance', () => {
    expect(
      receiveStockResponseSchema.safeParse({
        operationId: OPERATION_ID,
        movementId: VARIANT_ID,
        quantityAfter: -1,
      }).success,
    ).toBe(false);
  });
});
