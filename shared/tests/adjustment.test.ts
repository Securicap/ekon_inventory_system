import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_REASONS,
  MAX_MOVEMENT_NOTE_LENGTH,
  MAX_MOVEMENT_QUANTITY,
  REMOVAL_REASONS,
  adjustStockRequestSchema,
  adjustStockResponseSchema,
  adjustmentReasonSchema,
  receiveStockResponseSchema,
} from '../src/index.js';

/**
 * The adjustment contract: what a caller may state when the recorded quantity
 * was wrong, and what they are told.
 *
 * Most of these tests are about what the schema *refuses*. A field the server
 * owns must be rejected rather than ignored — and one of them matters more here
 * than anywhere else in the system: `movementType`. The server derives
 * `ADJUSTMENT_IN` or `ADJUSTMENT_OUT` from the sign of the delta, so a client
 * that could also name the type could post an increase that removed stock, and
 * the ledger would be permanently wrong in a way no reversal can un-say.
 */

const OPERATION_ID = '0198f0a0-0000-7000-8000-000000000001';
const VARIANT_ID = '0198f0a0-0000-7000-8000-000000000002';
const LOCATION_ID = '0198f0a0-0000-7000-8000-000000000003';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    variantId: VARIANT_ID,
    locationId: LOCATION_ID,
    quantityDelta: -2,
    reason: 'DATA_ENTRY_ERROR',
    occurredAt: '2026-08-06T14:30:00.000Z',
    ...overrides,
  };
}

describe('the adjustment reason vocabulary', () => {
  it('describes the record, not the stock', () => {
    expect([...ADJUSTMENT_REASONS]).toEqual(['DATA_ENTRY_ERROR', 'MISSED_MOVEMENT', 'OTHER']);
  });

  it('shares nothing with the removal reasons except OTHER', () => {
    // The distinction is the whole point of having two vocabularies. `SOLD`,
    // `DAMAGED`, and `INTERNAL_USE` are things that happened to merchandise and
    // are always an `ISSUE`; a sale nobody recorded is a `MISSED_MOVEMENT`, and
    // a shop that could not tell those apart could not tell trade from
    // bookkeeping. `OTHER` is in both because both need an honest escape from a
    // list with no right answer.
    const shared = ADJUSTMENT_REASONS.filter((reason) =>
      (REMOVAL_REASONS as readonly string[]).includes(reason),
    );
    expect(shared).toEqual(['OTHER']);
  });

  it('refuses SOLD outright', () => {
    expect(adjustmentReasonSchema.safeParse('SOLD').success).toBe(false);
    expect(adjustStockRequestSchema.safeParse(request({ reason: 'SOLD' })).success).toBe(false);
  });

  it('refuses conclusions a variance has not yet supported', () => {
    // `SHRINKAGE`, `THEFT`, and `MISCOUNT` are explanations of a discrepancy,
    // and a discrepancy is what a physical count produces. Offering them here
    // would invite adjusting a balance to whatever was last counted and
    // recording a guess about why — which is the flattening that stops a shop
    // noticing it is being stolen from.
    for (const reason of ['SHRINKAGE', 'THEFT', 'MISCOUNT', 'SPOILAGE', 'COUNT']) {
      expect(adjustmentReasonSchema.safeParse(reason).success, reason).toBe(false);
    }
  });

  it('is machine-readable codes, not translated labels', () => {
    for (const reason of ADJUSTMENT_REASONS) expect(reason).toMatch(/^[A-Z][A-Z_]*$/);
  });

  it('accepts every reason it lists, and nothing that only looks like one', () => {
    for (const reason of ADJUSTMENT_REASONS) {
      expect(adjustmentReasonSchema.safeParse(reason).success, reason).toBe(true);
    }
    for (const rejected of ['data_entry_error', 'Data Entry Error', '', ' OTHER ']) {
      expect(adjustmentReasonSchema.safeParse(rejected).success, rejected).toBe(false);
    }
  });
});

describe('the signed delta', () => {
  it('accepts a correction in either direction', () => {
    expect(adjustStockRequestSchema.safeParse(request({ quantityDelta: 4 })).success).toBe(true);
    expect(adjustStockRequestSchema.safeParse(request({ quantityDelta: -4 })).success).toBe(true);
  });

  it('refuses zero', () => {
    // A movement that changes nothing is not a movement, and the ledger's own
    // CHECK says the same thing.
    expect(adjustStockRequestSchema.safeParse(request({ quantityDelta: 0 })).success).toBe(false);
  });

  it('refuses a fraction', () => {
    // A floating-point quantity in an inventory ledger is an unfixable defect
    // once history exists (INV-10).
    for (const delta of [1.5, -0.5, 2.000001]) {
      expect(adjustStockRequestSchema.safeParse(request({ quantityDelta: delta })).success).toBe(
        false,
      );
    }
  });

  it('refuses a quantity the ledger could not store, in either direction', () => {
    // The `integer` column's own ceiling, so an unstorable quantity is a 400
    // rather than a 500 from inside a transaction.
    expect(
      adjustStockRequestSchema.safeParse(request({ quantityDelta: MAX_MOVEMENT_QUANTITY })).success,
    ).toBe(true);
    expect(
      adjustStockRequestSchema.safeParse(request({ quantityDelta: MAX_MOVEMENT_QUANTITY + 1 }))
        .success,
    ).toBe(false);
    expect(
      adjustStockRequestSchema.safeParse(request({ quantityDelta: -MAX_MOVEMENT_QUANTITY - 1 }))
        .success,
    ).toBe(false);
  });
});

describe('the note', () => {
  it('is optional for a reason that speaks for itself', () => {
    expect(adjustStockRequestSchema.safeParse(request()).success).toBe(true);
  });

  it('is required when the reason is OTHER', () => {
    // `OTHER` with nothing beside it records that somebody changed a balance
    // and declined to say why.
    expect(adjustStockRequestSchema.safeParse(request({ reason: 'OTHER' })).success).toBe(false);
    expect(
      adjustStockRequestSchema.safeParse(request({ reason: 'OTHER', note: 'Found in the back' }))
        .success,
    ).toBe(true);
  });

  it('refuses a blank note, which is an empty note wearing a value’s clothes', () => {
    expect(adjustStockRequestSchema.safeParse(request({ note: '   ' })).success).toBe(false);
  });

  it('is bounded by what the column can hold', () => {
    expect(
      adjustStockRequestSchema.safeParse(request({ note: 'x'.repeat(MAX_MOVEMENT_NOTE_LENGTH) }))
        .success,
    ).toBe(true);
    expect(
      adjustStockRequestSchema.safeParse(
        request({ note: 'x'.repeat(MAX_MOVEMENT_NOTE_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });

  it('is trimmed, so the stored note is what somebody meant to write', () => {
    const parsed = adjustStockRequestSchema.parse(request({ note: '  Counted twice  ' }));
    expect(parsed.note).toBe('Counted twice');
  });
});

describe('what the request refuses', () => {
  it.each([
    ['movementType', { movementType: 'ADJUSTMENT_IN' }],
    ['userId', { userId: VARIANT_ID }],
    ['movementId', { movementId: VARIANT_ID }],
    ['recordedAt', { recordedAt: '2026-08-06T14:30:00.000Z' }],
    ['quantityBefore', { quantityBefore: 5 }],
    ['quantityAfter', { quantityAfter: 3 }],
    ['requestHash', { requestHash: 'deadbeef' }],
    ['reasonCode', { reasonCode: 'DATA_ENTRY_ERROR' }],
    ['quantity', { quantity: 2 }],
  ])('refuses a body carrying %s', (_field, extra) => {
    expect(adjustStockRequestSchema.safeParse(request(extra)).success).toBe(false);
  });

  it('refuses reasonCode even though it names the right vocabulary', () => {
    // It is the ledger's column name. The public field is `reason`, and a
    // client that could set the column directly could write a reason no screen
    // offers and no report counts.
    const withColumnName = { ...request() };
    delete withColumnName.reason;
    expect(
      adjustStockRequestSchema.safeParse({ ...withColumnName, reasonCode: 'DATA_ENTRY_ERROR' })
        .success,
    ).toBe(false);
  });

  it.each(['operationId', 'variantId', 'locationId', 'quantityDelta', 'reason', 'occurredAt'])(
    'requires %s',
    (field) => {
      const incomplete = { ...request() };
      delete incomplete[field];
      expect(adjustStockRequestSchema.safeParse(incomplete).success).toBe(false);
    },
  );

  it('requires ids to be ids', () => {
    expect(adjustStockRequestSchema.safeParse(request({ variantId: 'variant-2' })).success).toBe(
      false,
    );
  });

  it('requires a real calendar date', () => {
    expect(
      adjustStockRequestSchema.safeParse(request({ occurredAt: '2026-02-31T10:00:00.000Z' }))
        .success,
    ).toBe(false);
  });

  it('accepts a local offset, because the laptop stating the time is in Haiti', () => {
    expect(
      adjustStockRequestSchema.safeParse(request({ occurredAt: '2026-08-06T09:30:00-05:00' }))
        .success,
    ).toBe(true);
  });
});

describe('the response', () => {
  it('is the same three fields every other command answers with', () => {
    expect(adjustStockResponseSchema).toBe(receiveStockResponseSchema);
  });

  it('does not echo the movement type the server derived', () => {
    expect(
      adjustStockResponseSchema.safeParse({
        operationId: OPERATION_ID,
        movementId: VARIANT_ID,
        quantityAfter: 3,
        movementType: 'ADJUSTMENT_OUT',
      }).success,
    ).toBe(false);
  });
});
