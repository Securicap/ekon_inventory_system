import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_REASONS,
  COUNT_RECONCILIATION_REASONS,
  COUNT_STATUSES,
  MAX_MOVEMENT_NOTE_LENGTH,
  MAX_MOVEMENT_QUANTITY,
  countPathParamsSchema,
  countQuerySchema,
  countRecordSchema,
  countStatusSchema,
  countReconciliationReasonSchema,
  recordCountRequestSchema,
  reconcileCountRequestSchema,
} from '../src/index.js';

/**
 * The count contracts: what a person may state about a shelf, and what they may
 * decide about the difference.
 *
 * Most of these tests are about what the schemas *refuse*, and one refusal
 * matters more than every other in this package: `expectedQuantity`. The whole
 * evidentiary content of a count is the gap between what Ekon believed and what
 * somebody saw, and a client that could supply the first half could manufacture
 * any gap it liked.
 */

const OPERATION_ID = '0198f0a0-0000-7000-8000-000000000001';
const VARIANT_ID = '0198f0a0-0000-7000-8000-000000000002';
const LOCATION_ID = '0198f0a0-0000-7000-8000-000000000003';

function countRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    variantId: VARIANT_ID,
    locationId: LOCATION_ID,
    countedQuantity: 6,
    countedAt: '2026-08-06T14:30:00.000Z',
    ...overrides,
  };
}

function reconcileRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { operationId: OPERATION_ID, reason: 'SHRINKAGE', ...overrides };
}

describe('the count status vocabulary', () => {
  it('is three states and no approval workflow', () => {
    expect([...COUNT_STATUSES]).toEqual(['MATCHED', 'OPEN', 'RECONCILED']);
  });

  it('has no draft, review, approval, rejection, or cancellation', () => {
    // Every one of them belongs to a workflow this shop does not have, and a
    // status nobody sets is a status somebody eventually sets wrongly.
    for (const absent of [
      'DRAFT',
      'SUBMITTED',
      'MANAGER_REVIEW',
      'APPROVED',
      'REJECTED',
      'SECOND_COUNT_REQUIRED',
      'CLOSED',
      'CANCELLED',
    ]) {
      expect(countStatusSchema.safeParse(absent).success, absent).toBe(false);
    }
  });

  it('keeps a match and an accepted discrepancy apart', () => {
    // Nothing was decided about a match, so calling it reconciled would
    // attribute a judgement to somebody who never made one.
    expect(COUNT_STATUSES).toContain('MATCHED');
    expect(COUNT_STATUSES).toContain('RECONCILED');
  });
});

describe('the reconciliation reason vocabulary', () => {
  it('names the conclusions an investigation can reach', () => {
    expect([...COUNT_RECONCILIATION_REASONS]).toEqual([
      'UNRECORDED_SALE',
      'MISSED_RECEIPT',
      'DAMAGED',
      'MISPLACED_STOCK',
      'SHRINKAGE',
      'DATA_ENTRY_ERROR',
      'OTHER',
    ]);
  });

  it('does not offer COUNTING_ERROR', () => {
    // The most important omission in the contract. If the count itself was
    // wrong then the shelf never differed and there is nothing to accept — the
    // answer is to count again and record a new observation. A reason that let
    // somebody post a stock movement derived from a quantity they believe is
    // false would make this workflow a way of laundering bad data through the
    // ledger.
    expect(countReconciliationReasonSchema.safeParse('COUNTING_ERROR').success).toBe(false);
    expect(
      reconcileCountRequestSchema.safeParse(reconcileRequest({ reason: 'COUNTING_ERROR' })).success,
    ).toBe(false);
  });

  it('does not offer THEFT', () => {
    // A count can establish that stock is gone and cannot establish who took
    // it. `SHRINKAGE` records the loss; the note records what was found.
    expect(countReconciliationReasonSchema.safeParse('THEFT').success).toBe(false);
    expect(COUNT_RECONCILIATION_REASONS).toContain('SHRINKAGE');
  });

  it('is not the adjustment vocabulary', () => {
    // An adjustment says the recorded number was wrong with no observation
    // necessarily behind it; a reconciliation says somebody counted, it
    // differed, and this is what the investigation concluded. `OTHER` and
    // `DATA_ENTRY_ERROR` are the only names the two share, and each means
    // something different in its own workflow.
    const shared = COUNT_RECONCILIATION_REASONS.filter((reason) =>
      (ADJUSTMENT_REASONS as readonly string[]).includes(reason),
    );
    expect(shared).toEqual(['DATA_ENTRY_ERROR', 'OTHER']);
    expect(countReconciliationReasonSchema.safeParse('MISSED_MOVEMENT').success).toBe(false);
  });

  it('is machine-readable codes, not translated labels', () => {
    for (const reason of COUNT_RECONCILIATION_REASONS) expect(reason).toMatch(/^[A-Z][A-Z_]*$/);
  });
});

describe('recording an observation', () => {
  it('accepts the smallest complete statement about a shelf', () => {
    expect(recordCountRequestSchema.safeParse(countRequest()).success).toBe(true);
  });

  it('accepts a count of zero, which is a real observation', () => {
    // An empty shelf is exactly the count somebody most needs to record.
    expect(recordCountRequestSchema.safeParse(countRequest({ countedQuantity: 0 })).success).toBe(
      true,
    );
  });

  it.each([
    ['expectedQuantity', { expectedQuantity: 7 }],
    ['variance', { variance: -1 }],
    ['status', { status: 'OPEN' }],
    ['movementId', { movementId: VARIANT_ID }],
    ['reconciledBy', { reconciledBy: VARIANT_ID }],
    ['reconciledAt', { reconciledAt: '2026-08-06T14:30:00.000Z' }],
    ['reason', { reason: 'SHRINKAGE' }],
    ['recordedAt', { recordedAt: '2026-08-06T14:30:00.000Z' }],
    ['countedByUserId', { countedByUserId: VARIANT_ID }],
    ['id', { id: VARIANT_ID }],
  ])('refuses a body carrying %s', (_field, extra) => {
    expect(recordCountRequestSchema.safeParse(countRequest(extra)).success).toBe(false);
  });

  it('refuses a negative count', () => {
    // A person cannot count minus three of something.
    expect(recordCountRequestSchema.safeParse(countRequest({ countedQuantity: -1 })).success).toBe(
      false,
    );
  });

  it('refuses a fractional count', () => {
    expect(recordCountRequestSchema.safeParse(countRequest({ countedQuantity: 2.5 })).success).toBe(
      false,
    );
  });

  it('refuses a quantity the ledger could not store', () => {
    expect(
      recordCountRequestSchema.safeParse(countRequest({ countedQuantity: MAX_MOVEMENT_QUANTITY }))
        .success,
    ).toBe(true);
    expect(
      recordCountRequestSchema.safeParse(
        countRequest({ countedQuantity: MAX_MOVEMENT_QUANTITY + 1 }),
      ).success,
    ).toBe(false);
  });

  it.each(['operationId', 'variantId', 'locationId', 'countedQuantity', 'countedAt'])(
    'requires %s',
    (field) => {
      const incomplete = { ...countRequest() };
      delete incomplete[field];
      expect(recordCountRequestSchema.safeParse(incomplete).success).toBe(false);
    },
  );

  it('accepts a local offset and refuses a date that does not exist', () => {
    // The laptop stating when the shelf was walked is in Haiti and its clock is
    // local; `2026-02-31` is a typo that would otherwise be stored as 3 March.
    expect(
      recordCountRequestSchema.safeParse(countRequest({ countedAt: '2026-08-06T09:30:00-05:00' }))
        .success,
    ).toBe(true);
    expect(
      recordCountRequestSchema.safeParse(countRequest({ countedAt: '2026-02-31T10:00:00.000Z' }))
        .success,
    ).toBe(false);
  });
});

describe('reconciling a discrepancy', () => {
  it('accepts a decision and nothing else', () => {
    expect(reconcileCountRequestSchema.safeParse(reconcileRequest()).success).toBe(true);
  });

  it.each([
    ['variantId', { variantId: VARIANT_ID }],
    ['locationId', { locationId: LOCATION_ID }],
    ['expectedQuantity', { expectedQuantity: 7 }],
    ['countedQuantity', { countedQuantity: 6 }],
    ['variance', { variance: -1 }],
    ['quantityDelta', { quantityDelta: -1 }],
    ['movementType', { movementType: 'COUNT_RECONCILIATION' }],
    ['movementId', { movementId: VARIANT_ID }],
    ['reconciledBy', { reconciledBy: VARIANT_ID }],
    ['status', { status: 'RECONCILED' }],
    ['occurredAt', { occurredAt: '2026-08-06T14:30:00.000Z' }],
    ['countId', { countId: VARIANT_ID }],
  ])('refuses a body carrying %s', (_field, extra) => {
    // Everything about what moves comes from the persisted count, and the count
    // id is in the path where a route parameter cannot disagree with a payload.
    expect(reconcileCountRequestSchema.safeParse(reconcileRequest(extra)).success).toBe(false);
  });

  it('requires a note when the reason is OTHER', () => {
    expect(
      reconcileCountRequestSchema.safeParse(reconcileRequest({ reason: 'OTHER' })).success,
    ).toBe(false);
    expect(
      reconcileCountRequestSchema.safeParse(
        reconcileRequest({ reason: 'OTHER', note: 'Two boxes behind the counter' }),
      ).success,
    ).toBe(true);
  });

  it('bounds and trims the note', () => {
    expect(reconcileCountRequestSchema.safeParse(reconcileRequest({ note: '   ' })).success).toBe(
      false,
    );
    expect(
      reconcileCountRequestSchema.safeParse(
        reconcileRequest({ note: 'x'.repeat(MAX_MOVEMENT_NOTE_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    expect(
      reconcileCountRequestSchema.parse(reconcileRequest({ note: '  Found in the stockroom  ' }))
        .note,
    ).toBe('Found in the stockroom');
  });

  it('validates the count id in the path', () => {
    expect(countPathParamsSchema.safeParse({ countId: VARIANT_ID }).success).toBe(true);
    expect(countPathParamsSchema.safeParse({ countId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('the count record', () => {
  const RECORD = {
    id: VARIANT_ID,
    variant: {
      id: VARIANT_ID,
      productId: LOCATION_ID,
      productName: 'Bel Ami',
      brandName: 'Steve Madden',
      sku: 'EKN-AB12CD34',
      attributes: [{ name: 'size', value: '38' }],
    },
    location: { id: LOCATION_ID, name: 'Main Store' },
    expectedQuantity: 7,
    countedQuantity: 6,
    variance: -1,
    countedAt: '2026-08-06T14:30:00.000Z',
    recordedAt: '2026-08-06T15:00:00.000Z',
    counter: { id: OPERATION_ID, displayName: 'Marie' },
    status: 'OPEN',
    reconciliation: null,
  };

  it('accepts an unresolved discrepancy', () => {
    const parsed = countRecordSchema.parse(RECORD);
    expect(parsed.variance).toBe(-1);
    expect(parsed.reconciliation).toBeNull();
  });

  it('accepts a negative, a zero, and a positive variance', () => {
    for (const [counted, variance] of [
      [6, -1],
      [7, 0],
      [9, 2],
    ]) {
      expect(
        countRecordSchema.safeParse({
          ...RECORD,
          countedQuantity: counted,
          variance,
          status: variance === 0 ? 'MATCHED' : 'OPEN',
        }).success,
      ).toBe(true);
    }
  });

  it('accepts a settled discrepancy with its movement', () => {
    const parsed = countRecordSchema.parse({
      ...RECORD,
      status: 'RECONCILED',
      reconciliation: {
        reason: 'SHRINKAGE',
        note: 'Two missing from the display',
        reconciledAt: '2026-08-07T09:00:00.000Z',
        actor: { id: LOCATION_ID, displayName: 'Owner' },
        movementId: OPERATION_ID,
      },
    });
    expect(parsed.reconciliation?.movementId).toBe(OPERATION_ID);
  });

  it('refuses a reconciliation with no movement behind it', () => {
    // A reconciliation that changed no stock is not a reconciliation; a zero
    // variance settles as MATCHED without one.
    const { movementId: _movementId, ...incomplete } = {
      reason: 'SHRINKAGE',
      note: null,
      reconciledAt: '2026-08-07T09:00:00.000Z',
      actor: { id: LOCATION_ID, displayName: 'Owner' },
      movementId: OPERATION_ID,
    };
    expect(
      countRecordSchema.safeParse({
        ...RECORD,
        status: 'RECONCILED',
        reconciliation: incomplete,
      }).success,
    ).toBe(false);
  });

  it('refuses ledger internals that are not count evidence', () => {
    for (const extra of [
      { operationId: OPERATION_ID },
      { requestHash: 'abc' },
      { quantityAfter: 6 },
      { countedByUserId: OPERATION_ID },
    ]) {
      expect(countRecordSchema.safeParse({ ...RECORD, ...extra }).success).toBe(false);
    }
  });
});

describe('the count query', () => {
  it('defaults to the most recent page of everything', () => {
    const parsed = countQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.status).toBeUndefined();
  });

  it('narrows by status, variant, and location', () => {
    const parsed = countQuerySchema.parse({
      status: 'OPEN',
      variantId: VARIANT_ID,
      locationId: LOCATION_ID,
    });
    expect(parsed.status).toBe('OPEN');
  });

  it('refuses a mistyped filter rather than ignoring it', () => {
    // A query filtered by `varientId` would otherwise be answered with every
    // count and look like it had worked.
    expect(countQuerySchema.safeParse({ varientId: VARIANT_ID }).success).toBe(false);
  });

  it('bounds the page at both ends', () => {
    expect(countQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(countQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(countQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('refuses a backwards date range', () => {
    expect(
      countQuerySchema.safeParse({
        recordedFrom: '2026-08-07T00:00:00.000Z',
        recordedTo: '2026-08-06T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
