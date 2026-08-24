import { describe, expect, it } from 'vitest';
import {
  COUNT_RECONCILE_OPERATION_TYPE,
  countReconciliationCanonicalFields,
  countReconciliationRequestHash,
  type CountReconciliationCommandFacts,
} from '../../../src/modules/inventory/domain/countReconciliationRequestHash.js';
import {
  COUNT_RECORD_OPERATION_TYPE,
  countCanonicalFields,
  countRequestHash,
  type CountCommandFacts,
} from '../../../src/modules/inventory/domain/countRequestHash.js';

/**
 * The two digests counting needs: one for an observation, one for the decision
 * about it.
 *
 * The generic canonicalization — sorting, type tags, escaping, number forms —
 * is `platform/hash/canonicalRequest.ts` and is tested with receiving's hash.
 * What is workflow-specific, and what this file is for, is *which fields make
 * up each command*.
 */

const COUNT: CountCommandFacts = {
  variantId: '0198f0a0-0000-7000-8000-000000000001',
  locationId: '0198f0a0-0000-7000-8000-000000000002',
  countedQuantity: 6,
  countedAt: new Date('2026-08-06T14:30:00.000Z'),
  actorId: '0198f0a0-0000-7000-8000-000000000003',
};

const RECONCILIATION: CountReconciliationCommandFacts = {
  countId: '0198f0a0-0000-7000-8000-000000000004',
  reason: 'SHRINKAGE',
  note: null,
  actorId: '0198f0a0-0000-7000-8000-000000000003',
};

const OTHER_ID = '0198f0a0-0000-7000-8000-00000000000f';

describe('a count observation hashes to one value', () => {
  it('is stable, and is a sha-256 hex digest', () => {
    expect(countRequestHash(COUNT)).toBe(countRequestHash(COUNT));
    expect(countRequestHash(COUNT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on how the same instant was written on the wire', () => {
    expect(countRequestHash({ ...COUNT, countedAt: new Date('2026-08-06T09:30:00-05:00') })).toBe(
      countRequestHash(COUNT),
    );
  });

  it.each<[string, Partial<CountCommandFacts>]>([
    ['variant', { variantId: OTHER_ID }],
    ['location', { locationId: OTHER_ID }],
    ['quantity', { countedQuantity: 7 }],
    ['counted-at', { countedAt: new Date('2026-08-06T14:30:01.000Z') }],
    ['counter', { actorId: OTHER_ID }],
  ])('a different %s is a different observation', (_what, change) => {
    expect(countRequestHash({ ...COUNT, ...change })).not.toBe(countRequestHash(COUNT));
  });

  it('tells a count of zero from a count of one', () => {
    // An empty shelf is a real observation and must not collide with anything.
    expect(countRequestHash({ ...COUNT, countedQuantity: 0 })).not.toBe(
      countRequestHash({ ...COUNT, countedQuantity: 1 }),
    );
  });

  it('covers exactly the six business fields', () => {
    expect(Object.keys(countCanonicalFields(COUNT)).sort()).toEqual([
      'actorId',
      'countedAt',
      'countedQuantity',
      'locationId',
      'variantId',
      'workflow',
    ]);
  });

  it('does not hash the expected quantity', () => {
    // The most important absence in this file. The expected quantity is not
    // part of the command — the caller never states it, and it can legitimately
    // differ between an attempt and its retry because the shop kept trading.
    // Hashing it would make a genuine retry look like a different command
    // exactly when a receipt had landed between the two attempts.
    const fields = Object.keys(countCanonicalFields(COUNT));
    expect(fields).not.toContain('expectedQuantity');
    expect(fields).not.toContain('variance');
    expect(fields).not.toContain('status');
  });

  it('does not hash the count id, the recorded time, or the operation id', () => {
    const fields = Object.keys(countCanonicalFields(COUNT));
    for (const absent of ['id', 'countId', 'recordedAt', 'operationId']) {
      expect(fields).not.toContain(absent);
    }
  });

  it('names the workflow, whose result is a count rather than a movement', () => {
    expect(countCanonicalFields(COUNT).workflow).toBe(COUNT_RECORD_OPERATION_TYPE);
    expect(COUNT_RECORD_OPERATION_TYPE).toBe('inventory.count.record');
  });
});

describe('a reconciliation hashes to one value', () => {
  it('is stable, and is a sha-256 hex digest', () => {
    expect(countReconciliationRequestHash(RECONCILIATION)).toBe(
      countReconciliationRequestHash(RECONCILIATION),
    );
    expect(countReconciliationRequestHash(RECONCILIATION)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, Partial<CountReconciliationCommandFacts>]>([
    ['count', { countId: OTHER_ID }],
    ['reason', { reason: 'UNRECORDED_SALE' }],
    ['note', { note: 'Found behind the counter' }],
    ['reconciler', { actorId: OTHER_ID }],
  ])('a different %s is a different decision', (_what, change) => {
    expect(countReconciliationRequestHash({ ...RECONCILIATION, ...change })).not.toBe(
      countReconciliationRequestHash(RECONCILIATION),
    );
  });

  it('tells the reasons apart from one another', () => {
    // The same −1 accepted as an unrecorded sale and as shrinkage is the same
    // arithmetic and opposite conclusions, and one operation id used across
    // them is a mistake worth refusing.
    const digests = (['UNRECORDED_SALE', 'SHRINKAGE', 'DAMAGED', 'MISPLACED_STOCK'] as const).map(
      (reason) => countReconciliationRequestHash({ ...RECONCILIATION, reason }),
    );
    expect(new Set(digests).size).toBe(4);
  });

  it('covers exactly the four fields', () => {
    expect(Object.keys(countReconciliationCanonicalFields(RECONCILIATION)).sort()).toEqual([
      'actorId',
      'countId',
      'note',
      'reason',
      'workflow',
    ]);
  });

  it.each(['variantId', 'locationId', 'quantityDelta', 'expectedQuantity', 'countedQuantity'])(
    'does not hash %s, which comes from the count',
    (field) => {
      expect(Object.keys(countReconciliationCanonicalFields(RECONCILIATION))).not.toContain(field);
    },
  );

  it('has no occurredAt, because the movement takes the count’s own', () => {
    expect(Object.keys(countReconciliationCanonicalFields(RECONCILIATION))).not.toContain(
      'occurredAt',
    );
  });

  it('names its own workflow, apart from every other command', () => {
    expect(countReconciliationCanonicalFields(RECONCILIATION).workflow).toBe(
      COUNT_RECONCILE_OPERATION_TYPE,
    );
    expect(COUNT_RECONCILE_OPERATION_TYPE).toBe('inventory.count.reconcile');
    expect(COUNT_RECONCILE_OPERATION_TYPE).not.toBe(COUNT_RECORD_OPERATION_TYPE);
  });

  it('does not collide with the observation it settles', () => {
    // Two commands about one shelf-check, and an operation id reused across
    // them must be refused rather than answered with the other's result.
    expect(countReconciliationRequestHash(RECONCILIATION)).not.toBe(countRequestHash(COUNT));
  });
});
