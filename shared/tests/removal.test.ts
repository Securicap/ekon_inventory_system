import { describe, expect, it } from 'vitest';
import {
  MAX_MOVEMENT_QUANTITY,
  MOVEMENT_TYPES,
  REASON_REQUIRED_MOVEMENT_TYPES,
  REMOVAL_REASONS,
  receiveStockResponseSchema,
  removalReasonSchema,
  removeStockRequestSchema,
  removeStockResponseSchema,
} from '../src/index.js';

/**
 * The removal contract: what a caller may state, and what they are told.
 *
 * The schema is the boundary of what this workflow will accept, and most of
 * these tests are about what it *refuses*. A field the server owns must be
 * rejected rather than ignored — a client that can send `userId` and get a
 * `201` will keep sending it, and eventually somebody will wire it up.
 */

const OPERATION_ID = '0198f0a0-0000-7000-8000-000000000001';
const VARIANT_ID = '0198f0a0-0000-7000-8000-000000000002';
const LOCATION_ID = '0198f0a0-0000-7000-8000-000000000003';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    variantId: VARIANT_ID,
    locationId: LOCATION_ID,
    quantity: 3,
    reason: 'SOLD',
    occurredAt: '2026-08-06T14:30:00.000Z',
    ...overrides,
  };
}

describe('the removal reason vocabulary', () => {
  it('is the four answers a counter can give honestly', () => {
    expect([...REMOVAL_REASONS]).toEqual(['SOLD', 'DAMAGED', 'INTERNAL_USE', 'OTHER']);
  });

  it('accepts every reason it lists, and nothing else', () => {
    for (const reason of REMOVAL_REASONS) {
      expect(removalReasonSchema.safeParse(reason).success, reason).toBe(true);
    }
    for (const rejected of ['sold', 'Sold', 'STOLEN', 'because', '', ' SOLD ']) {
      expect(removalReasonSchema.safeParse(rejected).success, rejected).toBe(false);
    }
  });

  it('is machine-readable codes, not translated labels', () => {
    // `SOLD` means the same thing in the database whatever language the person
    // who chose it was reading, and it stays readable when the interface has
    // been rewritten twice. A reason stored as "Vandi" or "Vendu" would be a
    // translation decision baked into permanent history.
    for (const reason of REMOVAL_REASONS) {
      expect(reason).toMatch(/^[A-Z][A-Z_]*$/);
    }
  });

  it('fits the ledger column that stores it', () => {
    // `inventory_movements.reason_code` is bounded at 60 characters, trimmed
    // and non-blank.
    for (const reason of REMOVAL_REASONS) {
      expect(reason.length).toBeLessThanOrEqual(60);
      expect(reason.trim()).toBe(reason);
    }
  });
});

describe('what a removal request may say', () => {
  it('accepts a well-formed command', () => {
    const parsed = removeStockRequestSchema.parse(request());
    expect(parsed.quantity).toBe(3);
    expect(parsed.reason).toBe('SOLD');
  });

  it('accepts a business time written with an offset', () => {
    expect(
      removeStockRequestSchema.safeParse(request({ occurredAt: '2026-08-06T09:30:00.000-05:00' }))
        .success,
    ).toBe(true);
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 2.5],
    ['a string', '3'],
    ['null', null],
    ['over the integer ceiling', MAX_MOVEMENT_QUANTITY + 1],
  ])('refuses a %s quantity', (_label, quantity) => {
    expect(removeStockRequestSchema.safeParse(request({ quantity })).success).toBe(false);
  });

  it('refuses a negative quantity rather than treating it as the delta', () => {
    // The workflow owns direction. A caller that could send `-5` would be
    // describing the ledger's representation rather than the business event,
    // and there would be two spellings of one command for a hash that has to
    // recognize a retry.
    expect(removeStockRequestSchema.safeParse(request({ quantity: -5 })).success).toBe(false);
    expect(removeStockRequestSchema.parse(request({ quantity: 5 })).quantity).toBe(5);
  });

  it('accepts the largest storable quantity', () => {
    expect(
      removeStockRequestSchema.safeParse(request({ quantity: MAX_MOVEMENT_QUANTITY })).success,
    ).toBe(true);
  });

  it.each([
    ['unknown', 'STOLEN'],
    ['lower-cased', 'sold'],
    ['a translated label', 'Vandi'],
    ['blank', ''],
    ['whitespace', '   '],
    ['free text', 'the customer took two'],
    ['null', null],
  ])('refuses a %s reason', (_label, reason) => {
    expect(removeStockRequestSchema.safeParse(request({ reason })).success).toBe(false);
  });

  it.each(['operationId', 'variantId', 'locationId', 'quantity', 'reason', 'occurredAt'])(
    'refuses a request with no %s',
    (field) => {
      const payload = request();
      delete payload[field];
      expect(removeStockRequestSchema.safeParse(payload).success, field).toBe(false);
    },
  );

  it.each([
    ['malformed', 'yesterday'],
    ['date-only', '2026-08-06'],
    ['impossible', '2026-02-31T10:00:00.000Z'],
  ])('refuses a %s business time', (_label, occurredAt) => {
    expect(removeStockRequestSchema.safeParse(request({ occurredAt })).success).toBe(false);
  });

  it.each(['operationId', 'variantId', 'locationId'])(
    'refuses a %s that is not a uuid',
    (field) => {
      expect(removeStockRequestSchema.safeParse(request({ [field]: 'retry-1' })).success).toBe(
        false,
      );
    },
  );

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
  ])('refuses a request that tries to supply %s', (field) => {
    // Every one of these is the server's. `reasonCode` is refused for a subtler
    // reason than the rest: it is the ledger's column name, and the public
    // field is `reason` from a closed vocabulary. A client that could set the
    // column directly could write a reason no screen offers and no report
    // counts.
    expect(removeStockRequestSchema.safeParse(request({ [field]: 'anything' })).success).toBe(
      false,
    );
  });
});

describe('what a removal answers with', () => {
  const result = {
    operationId: OPERATION_ID,
    movementId: '0198f0a0-0000-7000-8000-00000000000a',
    quantityAfter: 4,
  };

  it('is exactly three fields', () => {
    expect(Object.keys(removeStockResponseSchema.parse(result)).sort()).toEqual([
      'movementId',
      'operationId',
      'quantityAfter',
    ]);
  });

  it('accepts a resulting quantity of zero', () => {
    // Removing the last of something is a success, not a refusal. The shelf is
    // empty; the request was not.
    expect(removeStockResponseSchema.safeParse({ ...result, quantityAfter: 0 }).success).toBe(true);
  });

  it('refuses a negative resulting quantity', () => {
    // A shelf cannot hold minus three items, on any path, in any contract.
    expect(removeStockResponseSchema.safeParse({ ...result, quantityAfter: -1 }).success).toBe(
      false,
    );
  });

  it('does not echo the reason, the delta, or anything the ledger keeps', () => {
    for (const field of ['reason', 'reasonCode', 'quantityDelta', 'quantityBefore', 'userId']) {
      expect(removeStockResponseSchema.safeParse({ ...result, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
  });

  it('is the same contract receiving answers with, written once', () => {
    // Both workflows answer "which command, which movement, what is left", and
    // two hand-written copies of one contract are two things to keep in step.
    expect(removeStockResponseSchema).toBe(receiveStockResponseSchema);
  });
});

describe('removal in the movement vocabulary', () => {
  it('posts an ISSUE, which is a type of its own', () => {
    expect(MOVEMENT_TYPES).toContain('ISSUE');
  });

  it('requires a reason at the ledger level', () => {
    // The type says stock left; the reason says whether that was trade or loss.
    // Without it the movement is half a record.
    expect(REASON_REQUIRED_MOVEMENT_TYPES).toContain('ISSUE');
  });
});
