import { describe, expect, it } from 'vitest';
import {
  inventoryMovementRecordSchema,
  movementHistoryPageSchema,
  movementHistoryQuerySchema,
  MOVEMENT_HISTORY_DEFAULT_PAGE_SIZE,
  MOVEMENT_HISTORY_MAX_PAGE_SIZE,
} from '../src/index.js';

/** One fully-settled record, for tests that vary a single field of it. */
const RECORD = {
  id: '00000000-0000-7000-8000-000000000001',
  movementType: 'ISSUE',
  quantityDelta: -1,
  quantityBefore: 7,
  quantityAfter: 6,
  reasonCode: 'SOLD',
  note: null,
  occurredAt: '2026-08-23T14:20:00.000Z',
  recordedAt: '2026-08-23T14:22:10.000Z',
  operationId: '00000000-0000-7000-8000-000000000002',
  reversesMovementId: null,
  reversedByMovementId: null,
  variant: {
    id: '00000000-0000-7000-8000-000000000003',
    productId: '00000000-0000-7000-8000-000000000004',
    productName: 'Bel Ami',
    brandName: 'Steve Madden',
    sku: 'EKN-ABCDEFGH',
    attributes: [{ name: 'color', value: 'Black' }],
  },
  location: { id: '00000000-0000-7000-8000-000000000005', name: 'Main Store' },
  actor: { id: '00000000-0000-7000-8000-000000000006', displayName: 'Marie Joseph' },
};

describe('movement history query contract', () => {
  it('asks for the most recent page of everything when nothing is given', () => {
    const query = movementHistoryQuerySchema.parse({});
    expect(query.limit).toBe(MOVEMENT_HISTORY_DEFAULT_PAGE_SIZE);
    expect(query.variantId).toBeUndefined();
    expect(query.cursor).toBeUndefined();
  });

  it('accepts every filter it supports', () => {
    const query = movementHistoryQuerySchema.parse({
      variantId: '00000000-0000-7000-8000-000000000003',
      locationId: '00000000-0000-7000-8000-000000000005',
      movementType: 'RECEIPT',
      recordedFrom: '2026-08-01T00:00:00.000Z',
      recordedTo: '2026-08-31T23:59:59.000Z',
      limit: '25',
      cursor: 'abc',
    });
    expect(query.movementType).toBe('RECEIPT');
    // A query string carries numbers as text; the schema coerces once, here.
    expect(query.limit).toBe(25);
  });

  it('refuses an id that is not a uuid', () => {
    expect(movementHistoryQuerySchema.safeParse({ variantId: 'not-a-uuid' }).success).toBe(false);
    expect(movementHistoryQuerySchema.safeParse({ locationId: '12345' }).success).toBe(false);
  });

  it('refuses a movement type outside the shared vocabulary', () => {
    expect(movementHistoryQuerySchema.safeParse({ movementType: 'SALE' }).success).toBe(false);
    expect(movementHistoryQuerySchema.safeParse({ movementType: 'receipt' }).success).toBe(false);
  });

  it('bounds the page at both ends', () => {
    expect(movementHistoryQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(movementHistoryQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
    expect(movementHistoryQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
    expect(
      movementHistoryQuerySchema.safeParse({ limit: String(MOVEMENT_HISTORY_MAX_PAGE_SIZE) })
        .success,
    ).toBe(true);
    expect(
      movementHistoryQuerySchema.safeParse({ limit: String(MOVEMENT_HISTORY_MAX_PAGE_SIZE + 1) })
        .success,
    ).toBe(false);
  });

  it('refuses a malformed date bound', () => {
    expect(movementHistoryQuerySchema.safeParse({ recordedFrom: 'yesterday' }).success).toBe(false);
    expect(movementHistoryQuerySchema.safeParse({ recordedTo: '2026-08-01' }).success).toBe(false);
  });

  it('refuses a range that runs backwards', () => {
    expect(
      movementHistoryQuerySchema.safeParse({
        recordedFrom: '2026-08-31T00:00:00.000Z',
        recordedTo: '2026-08-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('accepts a range of one instant', () => {
    expect(
      movementHistoryQuerySchema.safeParse({
        recordedFrom: '2026-08-01T00:00:00.000Z',
        recordedTo: '2026-08-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('refuses a parameter it does not recognize', () => {
    // A dropped filter would answer with the whole ledger and look like it had
    // worked, which is worse than refusing.
    expect(movementHistoryQuerySchema.safeParse({ varientId: 'x' }).success).toBe(false);
    expect(movementHistoryQuerySchema.safeParse({ occurredFrom: '2026-08-01' }).success).toBe(
      false,
    );
    expect(movementHistoryQuerySchema.safeParse({ page: '2' }).success).toBe(false);
  });

  it('refuses an empty cursor rather than treating it as absent', () => {
    expect(movementHistoryQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('movement history record contract', () => {
  it('accepts a fully resolved record', () => {
    expect(inventoryMovementRecordSchema.parse(RECORD).reasonCode).toBe('SOLD');
  });

  it('keeps ISSUE and SOLD as what the ledger recorded', () => {
    // Deliberately not collapsed into a `SALE`: there is no sale entity in this
    // system, and `Remove -> SOLD` is transitional rather than permanent.
    const record = inventoryMovementRecordSchema.parse(RECORD);
    expect(record.movementType).toBe('ISSUE');
    expect(record.reasonCode).toBe('SOLD');
  });

  it('allows an actor whose name no longer resolves, keeping the permanent id', () => {
    const record = inventoryMovementRecordSchema.parse({
      ...RECORD,
      actor: { id: RECORD.actor.id, displayName: null },
    });
    expect(record.actor.id).toBe(RECORD.actor.id);
    expect(record.actor.displayName).toBeNull();
  });

  it('refuses an actor with no id at all', () => {
    expect(
      inventoryMovementRecordSchema.safeParse({ ...RECORD, actor: { displayName: 'X' } }).success,
    ).toBe(false);
  });

  it('allows unbranded merchandise', () => {
    const record = inventoryMovementRecordSchema.parse({
      ...RECORD,
      variant: { ...RECORD.variant, brandName: null },
    });
    expect(record.variant.brandName).toBeNull();
  });

  it('allows a receipt, which carries no reason', () => {
    const record = inventoryMovementRecordSchema.parse({
      ...RECORD,
      movementType: 'RECEIPT',
      quantityDelta: 7,
      quantityBefore: 0,
      quantityAfter: 7,
      reasonCode: null,
    });
    expect(record.reasonCode).toBeNull();
  });

  it('refuses the chain pointer outright', () => {
    // `previousMovementId` is the mechanism that makes a shelf's history
    // unforkable, not a business fact, and `quantityBefore`/`quantityAfter`
    // already answer everything a reader would use it for. `.strict()` means a
    // server that started sending it would fail this contract rather than leak
    // an internal into a shape clients then depend on.
    expect(
      inventoryMovementRecordSchema.safeParse({
        ...RECORD,
        previousMovementId: '00000000-0000-7000-8000-00000000000a',
      }).success,
    ).toBe(false);
  });

  it('carries the reversal relationship in both directions', () => {
    // A reversal says what it undid; the movement it undid says it was undone.
    // The second is the one that keeps somebody from reading a corrected
    // receipt as stock the shop still received.
    const reversal = inventoryMovementRecordSchema.parse({
      ...RECORD,
      movementType: 'REVERSAL',
      reversesMovementId: '00000000-0000-7000-8000-00000000000b',
    });
    expect(reversal.reversesMovementId).toBe('00000000-0000-7000-8000-00000000000b');
    expect(reversal.reversedByMovementId).toBeNull();

    const reversed = inventoryMovementRecordSchema.parse({
      ...RECORD,
      reversedByMovementId: '00000000-0000-7000-8000-00000000000c',
    });
    expect(reversed.reversedByMovementId).toBe('00000000-0000-7000-8000-00000000000c');
    expect(reversed.reversesMovementId).toBeNull();
  });

  it('requires both reversal fields to be stated, even as null', () => {
    // `.strict()` in both directions: a record that simply omitted "was this
    // corrected?" would read as "no" to every client.
    const withoutDerived = { ...RECORD };
    delete (withoutDerived as Record<string, unknown>).reversedByMovementId;
    expect(inventoryMovementRecordSchema.safeParse(withoutDerived).success).toBe(false);
  });

  it('refuses ledger internals that are not evidence', () => {
    for (const field of [
      { requestHash: 'abc' },
      { userId: '00000000-0000-7000-8000-000000000006' },
      { variantId: '00000000-0000-7000-8000-000000000003' },
    ]) {
      expect(inventoryMovementRecordSchema.safeParse({ ...RECORD, ...field }).success).toBe(false);
    }
  });
});

describe('movement history page contract', () => {
  it('treats an empty ledger as an empty page with no cursor', () => {
    expect(movementHistoryPageSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('carries a cursor when there is more to read', () => {
    const page = movementHistoryPageSchema.parse({ items: [RECORD], nextCursor: 'abc' });
    expect(page.nextCursor).toBe('abc');
  });
});
