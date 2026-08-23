import { describe, expect, it } from 'vitest';
import {
  REVERSAL_OPERATION_TYPE,
  reversalCanonicalFields,
  reversalRequestHash,
  type ReversalCommandFacts,
} from '../../../src/modules/inventory/domain/reversalRequestHash.js';

/**
 * The digest that decides whether a repeated operation id is a retry of a
 * reversal or a mistake.
 *
 * The field set is the shortest in the system, and that is the property worth
 * testing: everything about *what moves* comes from the original movement, so
 * hashing a variant, a location, or a quantity here would be hashing values the
 * caller never sent and could not vary. `movementId` already identifies all of
 * them.
 */

const FACTS: ReversalCommandFacts = {
  movementId: '0198f0a0-0000-7000-8000-000000000001',
  note: null,
  occurredAt: new Date('2026-08-06T14:30:00.000Z'),
  actorId: '0198f0a0-0000-7000-8000-000000000003',
};

const OTHER_ID = '0198f0a0-0000-7000-8000-00000000000f';

describe('a reversal command hashes to one value', () => {
  it('is stable across calls', () => {
    expect(reversalRequestHash(FACTS)).toBe(reversalRequestHash(FACTS));
  });

  it('is a sha-256 hex digest', () => {
    expect(reversalRequestHash(FACTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on how the same instant was written on the wire', () => {
    expect(
      reversalRequestHash({ ...FACTS, occurredAt: new Date('2026-08-06T09:30:00-05:00') }),
    ).toBe(reversalRequestHash(FACTS));
  });
});

describe('every business fact changes the hash', () => {
  const original = reversalRequestHash(FACTS);

  it.each<[string, Partial<ReversalCommandFacts>]>([
    ['movement', { movementId: OTHER_ID }],
    ['note', { note: 'Booked in twice' }],
    ['occurred-at', { occurredAt: new Date('2026-08-06T14:30:01.000Z') }],
    ['actor', { actorId: OTHER_ID }],
  ])('a different %s is a different command', (_what, change) => {
    expect(reversalRequestHash({ ...FACTS, ...change })).not.toBe(original);
  });
});

describe('nothing derivable from the original movement is in the hash', () => {
  it('covers exactly the five fields', () => {
    expect(Object.keys(reversalCanonicalFields(FACTS)).sort()).toEqual([
      'actorId',
      'movementId',
      'note',
      'occurredAt',
      'workflow',
    ]);
  });

  it.each(['variantId', 'locationId', 'quantityDelta', 'movementType', 'reversesMovementId'])(
    'does not hash %s',
    (field) => {
      expect(Object.keys(reversalCanonicalFields(FACTS))).not.toContain(field);
    },
  );

  it('names the workflow rather than the movement type', () => {
    expect(reversalCanonicalFields(FACTS).workflow).toBe(REVERSAL_OPERATION_TYPE);
    expect(REVERSAL_OPERATION_TYPE).toBe('inventory.reverse');
  });
});
