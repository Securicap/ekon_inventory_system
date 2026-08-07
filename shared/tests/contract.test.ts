import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  HTTP_STATUS_BY_ERROR_CODE,
  MOVEMENT_TYPES,
  REASON_REQUIRED_MOVEMENT_TYPES,
  errorBodySchema,
  quantityDeltaSchema,
  quantitySchema,
} from '../src/index.js';

/**
 * These assertions guard the contract between the browser and the server. A
 * change here is a change both sides must agree on, and breaking it silently is
 * how a shop screen starts showing a raw error code to an employee.
 */
describe('error contract', () => {
  it('maps every error code to an http status', () => {
    for (const code of ERROR_CODES) {
      expect(HTTP_STATUS_BY_ERROR_CODE[code], `no status for ${code}`).toBeGreaterThanOrEqual(400);
    }
  });

  it('treats a replayed operation with a different body as a conflict', () => {
    // The client must be able to distinguish "you already did this" from a
    // genuine failure, because the two need different messages at the counter.
    expect(HTTP_STATUS_BY_ERROR_CODE.OPERATION_REPLAYED_WITH_DIFFERENT_BODY).toBe(409);
  });

  it('always carries a request id so a user can quote it for support', () => {
    const parsed = errorBodySchema.safeParse({
      error: { code: 'CONFLICT', message: 'boom' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a well-formed error body', () => {
    expect(
      errorBodySchema.safeParse({
        error: { code: 'INSUFFICIENT_STOCK', message: 'not enough', requestId: 'abc' },
      }).success,
    ).toBe(true);
  });
});

describe('quantity contract', () => {
  it('rejects fractional quantities', () => {
    // A float quantity in an inventory ledger is an unfixable defect once
    // history exists.
    expect(quantitySchema.safeParse(1.5).success).toBe(false);
    expect(quantitySchema.safeParse(3).success).toBe(true);
  });

  it('rejects negative quantities', () => {
    expect(quantitySchema.safeParse(-1).success).toBe(false);
  });

  it('rejects a zero delta', () => {
    // A movement that changes nothing is not a movement.
    expect(quantityDeltaSchema.safeParse(0).success).toBe(false);
    expect(quantityDeltaSchema.safeParse(-4).success).toBe(true);
  });
});

describe('movement contract', () => {
  it('requires a reason for issues and adjustments, and for nothing else', () => {
    // A receipt carries its reason in its type, a count in the count, and a
    // reversal in the movement it reverses. The other three cannot say what
    // happened without one.
    expect([...REASON_REQUIRED_MOVEMENT_TYPES].sort()).toEqual([
      'ADJUSTMENT_IN',
      'ADJUSTMENT_OUT',
      'ISSUE',
    ]);
    for (const type of REASON_REQUIRED_MOVEMENT_TYPES) {
      expect(MOVEMENT_TYPES).toContain(type);
    }
  });

  it('tells stock that left from stock that was mis-recorded', () => {
    // The distinction is permanent: this ledger is append-only, so a movement
    // written under the wrong one of these is wrong forever. Collapsing them
    // into one type would make trade and recording error the same fact.
    expect(MOVEMENT_TYPES).toContain('ISSUE');
    expect(MOVEMENT_TYPES).toContain('ADJUSTMENT_OUT');
  });

  it('names no business domain the system does not have', () => {
    // `ISSUE` and not `SALE`, `ORDER`, `SHIPMENT`, or `RETURN`. Stock leaving
    // is the ledger's fact; whether it was sold is a *reason*, and a column
    // that named a sales domain would be a claim about a module nobody has
    // designed.
    expect(MOVEMENT_TYPES.some((t) => /SALE|ORDER|SHIPMENT|RETURN|INVOICE/i.test(t))).toBe(false);
  });

  it('has no movement type that overwrites a quantity', () => {
    // Every way stock can change is a delta appended to the ledger. A type
    // named "set" or "override" would mean history had been abandoned.
    expect(MOVEMENT_TYPES.some((t) => /SET|OVERRIDE|CORRECT_TO/i.test(t))).toBe(false);
  });
});
