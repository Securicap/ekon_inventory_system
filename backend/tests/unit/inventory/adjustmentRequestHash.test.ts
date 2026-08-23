import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_OPERATION_TYPE,
  adjustmentCanonicalFields,
  adjustmentRequestHash,
  type AdjustmentCommandFacts,
} from '../../../src/modules/inventory/domain/adjustmentRequestHash.js';
import { removalCanonicalFields } from '../../../src/modules/inventory/domain/removalRequestHash.js';
import { canonicalRequestHash } from '../../../src/platform/hash/canonicalRequest.js';

/**
 * The digest that decides whether a repeated operation id is a retry of a
 * correction or a mistake.
 *
 * The generic canonicalization — sorting, type tags, escaping, number forms —
 * is `platform/hash/canonicalRequest.ts` and is tested with receiving's hash.
 * What is workflow-specific, and what this file is for, is *which fields make
 * up an adjustment command*:
 *
 *  1. everything that is the command changes the hash;
 *  2. nothing that is not the command changes it.
 */

const FACTS: AdjustmentCommandFacts = {
  variantId: '0198f0a0-0000-7000-8000-000000000001',
  locationId: '0198f0a0-0000-7000-8000-000000000002',
  quantityDelta: -2,
  reason: 'DATA_ENTRY_ERROR',
  note: null,
  occurredAt: new Date('2026-08-06T14:30:00.000Z'),
  actorId: '0198f0a0-0000-7000-8000-000000000003',
};

const OTHER_ID = '0198f0a0-0000-7000-8000-00000000000f';

describe('an adjustment command hashes to one value', () => {
  it('is stable across calls', () => {
    expect(adjustmentRequestHash(FACTS)).toBe(adjustmentRequestHash(FACTS));
  });

  it('is a sha-256 hex digest', () => {
    expect(adjustmentRequestHash(FACTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on how the same instant was written on the wire', () => {
    expect(
      adjustmentRequestHash({ ...FACTS, occurredAt: new Date('2026-08-06T09:30:00-05:00') }),
    ).toBe(adjustmentRequestHash(FACTS));
  });
});

describe('every business fact changes the hash', () => {
  const original = adjustmentRequestHash(FACTS);

  it.each<[string, Partial<AdjustmentCommandFacts>]>([
    ['variant', { variantId: OTHER_ID }],
    ['location', { locationId: OTHER_ID }],
    ['quantity', { quantityDelta: -3 }],
    ['reason', { reason: 'MISSED_MOVEMENT' }],
    ['note', { note: 'Counted the back shelf again' }],
    ['occurred-at', { occurredAt: new Date('2026-08-06T14:30:01.000Z') }],
    ['actor', { actorId: OTHER_ID }],
  ])('a different %s is a different command', (_what, change) => {
    expect(adjustmentRequestHash({ ...FACTS, ...change })).not.toBe(original);
  });

  it('tells a correction upward from the same correction downward', () => {
    // The sign is the command here, not a representation of it: `+2` and `−2`
    // are opposite statements about what the record got wrong, and an operation
    // id reused across them must not be answered with whichever arrived first.
    expect(adjustmentRequestHash({ ...FACTS, quantityDelta: 2 })).not.toBe(original);
  });

  it('tells an absent note from an empty-looking one', () => {
    expect(adjustmentRequestHash({ ...FACTS, note: '' })).not.toBe(original);
  });
});

describe('nothing the server derived or generated is in the hash', () => {
  it('covers exactly the eight business fields', () => {
    expect(Object.keys(adjustmentCanonicalFields(FACTS)).sort()).toEqual([
      'actorId',
      'locationId',
      'note',
      'occurredAt',
      'quantityDelta',
      'reason',
      'variantId',
      'workflow',
    ]);
  });

  it('hashes the signed delta the caller stated', () => {
    expect(adjustmentCanonicalFields(FACTS).quantityDelta).toBe(-2);
  });

  it('does not include the movement type it derives', () => {
    // `ADJUSTMENT_IN` or `ADJUSTMENT_OUT` follows from the sign of a field
    // already in the hash. A field that cannot vary independently looks like
    // protection and provides none.
    expect(Object.keys(adjustmentCanonicalFields(FACTS))).not.toContain('movementType');
  });

  it('does not include the operation id it is stored against', () => {
    // Including it would make every command hash uniquely, and the comparison
    // would never fail — which is the same as not comparing at all.
    expect(Object.keys(adjustmentCanonicalFields(FACTS))).not.toContain('operationId');
  });
});

describe('the workflow field keeps adjustment apart from every other command', () => {
  it('names the workflow rather than the movement type', () => {
    expect(adjustmentCanonicalFields(FACTS).workflow).toBe(ADJUSTMENT_OPERATION_TYPE);
    expect(ADJUSTMENT_OPERATION_TYPE).toBe('inventory.adjust');
  });

  it('hashes differently from a removal of the same units on the same shelf', () => {
    // The distinction the whole capability split rests on. Two units removed
    // because they were sold and two units removed because the record was wrong
    // move the same stock and mean opposite things; one operation id used for
    // both is a `409`, not a replay.
    const removal = canonicalRequestHash(
      removalCanonicalFields({
        variantId: FACTS.variantId,
        locationId: FACTS.locationId,
        quantity: 2,
        reason: 'SOLD',
        occurredAt: FACTS.occurredAt,
        actorId: FACTS.actorId,
      }),
    );
    expect(adjustmentRequestHash(FACTS)).not.toBe(removal);
  });
});
