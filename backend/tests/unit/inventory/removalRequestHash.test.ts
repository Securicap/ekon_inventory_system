import { describe, expect, it } from 'vitest';
import {
  REMOVAL_OPERATION_TYPE,
  removalCanonicalFields,
  removalRequestHash,
  type RemovalCommandFacts,
} from '../../../src/modules/inventory/domain/removalRequestHash.js';
import { receivingCanonicalFields } from '../../../src/modules/inventory/domain/receivingRequestHash.js';
import { canonicalRequestHash } from '../../../src/platform/hash/canonicalRequest.js';

/**
 * The digest that decides whether a repeated operation id is a retry of a
 * stock-out or a mistake.
 *
 * The generic canonicalization — sorting, type tags, escaping, number forms —
 * is `platform/hash/canonicalRequest.ts` and is tested with receiving's hash.
 * What is workflow-specific, and what this file is for, is *which fields make
 * up a removal command*:
 *
 *  1. everything that is the command changes the hash;
 *  2. nothing that is not the command changes it.
 *
 * Asserted against the canonical field set rather than a hard-coded digest.
 * Pinning one opaque string would make a harmless change to the encoding look
 * like a broken test, and would not say why.
 */

const FACTS: RemovalCommandFacts = {
  variantId: '0198f0a0-0000-7000-8000-000000000001',
  locationId: '0198f0a0-0000-7000-8000-000000000002',
  quantity: 3,
  reason: 'SOLD',
  occurredAt: new Date('2026-08-06T14:30:00.000Z'),
  actorId: '0198f0a0-0000-7000-8000-000000000003',
};

const OTHER_ID = '0198f0a0-0000-7000-8000-00000000000f';

describe('a removal command hashes to one value', () => {
  it('is stable across calls', () => {
    expect(removalRequestHash(FACTS)).toBe(removalRequestHash(FACTS));
  });

  it('is a sha-256 hex digest', () => {
    // The `operations.request_hash` column bounds this at 128 characters.
    expect(removalRequestHash(FACTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order the facts were written in', () => {
    const reordered: RemovalCommandFacts = {
      actorId: FACTS.actorId,
      occurredAt: FACTS.occurredAt,
      reason: FACTS.reason,
      quantity: FACTS.quantity,
      locationId: FACTS.locationId,
      variantId: FACTS.variantId,
    };
    expect(removalRequestHash(reordered)).toBe(removalRequestHash(FACTS));
  });

  it('does not depend on how the same instant was written on the wire', () => {
    // The service normalizes an offset timestamp to an instant before hashing,
    // so a shop laptop on local time and one on UTC retry the same command.
    expect(
      removalRequestHash({ ...FACTS, occurredAt: new Date('2026-08-06T09:30:00-05:00') }),
    ).toBe(removalRequestHash(FACTS));
  });

  it('does not depend on a separate Date object for the same instant', () => {
    expect(removalRequestHash({ ...FACTS, occurredAt: new Date(FACTS.occurredAt.getTime()) })).toBe(
      removalRequestHash(FACTS),
    );
  });
});

describe('every business fact changes the hash', () => {
  const original = removalRequestHash(FACTS);

  it.each<[string, Partial<RemovalCommandFacts>]>([
    ['variant', { variantId: OTHER_ID }],
    ['location', { locationId: OTHER_ID }],
    ['quantity', { quantity: 4 }],
    ['reason', { reason: 'DAMAGED' }],
    ['occurred-at', { occurredAt: new Date('2026-08-06T14:30:01.000Z') }],
    ['actor', { actorId: OTHER_ID }],
  ])('a different %s is a different command', (_what, change) => {
    expect(removalRequestHash({ ...FACTS, ...change })).not.toBe(original);
  });

  it('tells the reasons apart from one another', () => {
    // Two bottles sold and two bottles broken are not the same business fact,
    // and an operation id reused across them is a mistake worth refusing.
    const digests = (['SOLD', 'DAMAGED', 'INTERNAL_USE', 'OTHER'] as const).map((reason) =>
      removalRequestHash({ ...FACTS, reason }),
    );
    expect(new Set(digests).size).toBe(4);
  });
});

describe('nothing the server derived or generated is in the hash', () => {
  it('covers exactly the seven business fields', () => {
    // Read from the canonical field set rather than from the digest, because
    // "which fields" is the reviewable fact. A movement id or a recorded time
    // here would make every retry differ from the attempt it repeats.
    expect(Object.keys(removalCanonicalFields(FACTS)).sort()).toEqual([
      'actorId',
      'locationId',
      'occurredAt',
      'quantity',
      'reason',
      'variantId',
      'workflow',
    ]);
  });

  it('hashes the public positive quantity, not the negative delta', () => {
    // The digest is of the request that was made. Hashing `-3` would give a
    // removal of three units two representations, and a hash with two
    // spellings of one command cannot recognize a retry.
    expect(removalCanonicalFields(FACTS).quantity).toBe(3);
  });

  it('does not include the movement type or the delta it derives', () => {
    // Both are computed from fields already in the hash — `inventory.remove`
    // always posts an `ISSUE`, and the delta is always the negation of
    // `quantity`. A field that cannot vary independently looks like protection
    // and provides none.
    const fields = Object.keys(removalCanonicalFields(FACTS));
    expect(fields).not.toContain('movementType');
    expect(fields).not.toContain('quantityDelta');
  });

  it('does not include the operation id', () => {
    // The hash is stored *against* the operation id. Hashing the id too would
    // make every command unique, and the comparison could never fail.
    expect(Object.keys(removalCanonicalFields(FACTS))).not.toContain('operationId');
  });
});

describe('removal is not receiving', () => {
  it('names its own workflow', () => {
    expect(removalCanonicalFields(FACTS).workflow).toBe(REMOVAL_OPERATION_TYPE);
    expect(REMOVAL_OPERATION_TYPE).toBe('inventory.remove');
  });

  it('separates removal from any other workflow that posts an issue', () => {
    // A point of sale, if one is ever built, would post `ISSUE` movements too.
    // The workflow field is what keeps two different commands apart under one
    // operation id.
    const fields = removalCanonicalFields(FACTS);
    expect(canonicalRequestHash({ ...fields, workflow: 'inventory.point_of_sale' })).not.toBe(
      removalRequestHash(FACTS),
    );
  });

  it('cannot collide with a receipt of the same variant, quantity, and time', () => {
    // Booking in three and selling three, under one reused operation id, must
    // conflict rather than silently answer with the wrong movement.
    const receipt = receivingCanonicalFields({
      variantId: FACTS.variantId,
      locationId: FACTS.locationId,
      quantity: FACTS.quantity,
      occurredAt: FACTS.occurredAt,
      actorId: FACTS.actorId,
    });
    expect(canonicalRequestHash(receipt)).not.toBe(removalRequestHash(FACTS));
  });
});
