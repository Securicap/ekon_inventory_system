import { describe, expect, it } from 'vitest';
import {
  MAX_MOVEMENT_NOTE_LENGTH,
  receiveStockResponseSchema,
  reverseMovementRequestSchema,
  reverseMovementResponseSchema,
} from '../src/index.js';

/**
 * The reversal contract, which is mostly a list of things a caller may not say.
 *
 * A reversal derives everything about what moves from the movement it names:
 * the variant, the location, the quantity, and the direction. Each of those is
 * therefore refused rather than accepted-and-ignored, because a second
 * statement of a derived value can only ever disagree with the first — and the
 * one that would win is the one nobody reads.
 */

const OPERATION_ID = '0198f0a0-0000-7000-8000-000000000001';
const MOVEMENT_ID = '0198f0a0-0000-7000-8000-000000000002';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    movementId: MOVEMENT_ID,
    occurredAt: '2026-08-06T14:30:00.000Z',
    ...overrides,
  };
}

describe('what a caller states', () => {
  it('accepts the smallest complete command: which movement, and when', () => {
    expect(reverseMovementRequestSchema.safeParse(request()).success).toBe(true);
  });

  it('accepts an optional note', () => {
    const parsed = reverseMovementRequestSchema.parse(request({ note: 'Booked in twice' }));
    expect(parsed.note).toBe('Booked in twice');
  });

  it.each(['operationId', 'movementId', 'occurredAt'])('requires %s', (field) => {
    const incomplete = { ...request() };
    delete incomplete[field];
    expect(reverseMovementRequestSchema.safeParse(incomplete).success).toBe(false);
  });

  it('requires the movement id to be an id', () => {
    expect(
      reverseMovementRequestSchema.safeParse(request({ movementId: 'the-wrong-one' })).success,
    ).toBe(false);
  });
});

describe('what the request refuses because the original movement already says it', () => {
  it.each([
    ['variantId', { variantId: MOVEMENT_ID }],
    ['locationId', { locationId: MOVEMENT_ID }],
    ['quantityDelta', { quantityDelta: -5 }],
    ['quantity', { quantity: 5 }],
    ['movementType', { movementType: 'REVERSAL' }],
    ['reversesMovementId', { reversesMovementId: MOVEMENT_ID }],
  ])('refuses a body carrying %s', (_field, extra) => {
    expect(reverseMovementRequestSchema.safeParse(request(extra)).success).toBe(false);
  });

  it('refuses a quantity even when it would have been the right one', () => {
    // The point is not that the number is wrong; it is that the client is not
    // the authority on it. A caller that could state a quantity could "reverse"
    // a receipt of ten by three and leave the ledger claiming a correction it
    // never made.
    expect(reverseMovementRequestSchema.safeParse(request({ quantityDelta: -10 })).success).toBe(
      false,
    );
  });
});

describe('what the request refuses because the server owns it', () => {
  it.each([
    ['userId', { userId: MOVEMENT_ID }],
    ['recordedAt', { recordedAt: '2026-08-06T14:30:00.000Z' }],
    ['requestHash', { requestHash: 'deadbeef' }],
    ['reasonCode', { reasonCode: 'DATA_ENTRY_ERROR' }],
    ['reason', { reason: 'OTHER' }],
  ])('refuses a body carrying %s', (_field, extra) => {
    expect(reverseMovementRequestSchema.safeParse(request(extra)).success).toBe(false);
  });

  it('has no reason field at all, because a reversal takes its reason from the original', () => {
    // That is what makes it a reversal rather than a fresh movement in the
    // opposite direction, and it is why the ledger requires a reason code for
    // issues and adjustments only (INV-11).
    expect(Object.keys(reverseMovementRequestSchema.shape)).toEqual([
      'operationId',
      'movementId',
      'note',
      'occurredAt',
    ]);
  });
});

describe('the note', () => {
  it('refuses a blank one', () => {
    expect(reverseMovementRequestSchema.safeParse(request({ note: '  ' })).success).toBe(false);
  });

  it('is bounded by what the column can hold', () => {
    expect(
      reverseMovementRequestSchema.safeParse(
        request({ note: 'x'.repeat(MAX_MOVEMENT_NOTE_LENGTH) }),
      ).success,
    ).toBe(true);
    expect(
      reverseMovementRequestSchema.safeParse(
        request({ note: 'x'.repeat(MAX_MOVEMENT_NOTE_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });
});

describe('the business time', () => {
  it('is the correction’s own, and an offset is accepted', () => {
    // The mistake happened when it happened; this is when somebody put it
    // right, stated by a laptop whose clock is local.
    expect(
      reverseMovementRequestSchema.safeParse(request({ occurredAt: '2026-08-06T09:30:00-05:00' }))
        .success,
    ).toBe(true);
  });

  it('must be a real calendar date', () => {
    expect(
      reverseMovementRequestSchema.safeParse(request({ occurredAt: '2026-02-31T10:00:00.000Z' }))
        .success,
    ).toBe(false);
  });
});

describe('the response', () => {
  it('is the same three fields every other command answers with', () => {
    // Not widened because the original movement is complex. The command
    // endpoint reports success; the history endpoint is where the evidence is.
    expect(reverseMovementResponseSchema).toBe(receiveStockResponseSchema);
  });

  it('does not carry the original movement', () => {
    expect(
      reverseMovementResponseSchema.safeParse({
        operationId: OPERATION_ID,
        movementId: MOVEMENT_ID,
        quantityAfter: 0,
        reversesMovementId: MOVEMENT_ID,
      }).success,
    ).toBe(false);
  });
});
