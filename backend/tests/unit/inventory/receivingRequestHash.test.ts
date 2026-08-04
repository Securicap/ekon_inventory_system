import { describe, expect, it } from 'vitest';
import {
  RECEIVING_OPERATION_TYPE,
  receivingCanonicalFields,
  receivingRequestHash,
  type ReceivingCommandFacts,
} from '../../../src/modules/inventory/domain/receivingRequestHash.js';
import {
  canonicalRequestForm,
  canonicalRequestHash,
} from '../../../src/platform/hash/canonicalRequest.js';

/**
 * The digest that decides whether a repeated operation id is a retry or a
 * mistake. Two properties matter, and both are asserted here rather than
 * against a hard-coded digest — pinning one opaque string would make a harmless
 * change to the encoding look like a broken test, and would not say why.
 *
 *  1. Everything that is the command changes the hash.
 *  2. Nothing that is not the command changes it.
 */

const FACTS: ReceivingCommandFacts = {
  variantId: '0198f0a0-0000-7000-8000-000000000001',
  locationId: '0198f0a0-0000-7000-8000-000000000002',
  quantity: 12,
  occurredAt: new Date('2026-08-04T10:00:00.000Z'),
  actorId: '0198f0a0-0000-7000-8000-000000000003',
};

const OTHER_ID = '0198f0a0-0000-7000-8000-00000000000f';

describe('a receiving command hashes to one value', () => {
  it('is stable across calls', () => {
    expect(receivingRequestHash(FACTS)).toBe(receivingRequestHash(FACTS));
  });

  it('is a sha-256 hex digest', () => {
    // The `operations.request_hash` column bounds this at 128 characters.
    expect(receivingRequestHash(FACTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order the facts were written in', () => {
    const reordered: ReceivingCommandFacts = {
      actorId: FACTS.actorId,
      occurredAt: FACTS.occurredAt,
      quantity: FACTS.quantity,
      locationId: FACTS.locationId,
      variantId: FACTS.variantId,
    };
    expect(receivingRequestHash(reordered)).toBe(receivingRequestHash(FACTS));
  });

  it('does not depend on how the same instant was written on the wire', () => {
    // The route normalizes an offset timestamp to an instant before hashing, so
    // a shop laptop on local time and one on UTC retry the same command.
    const sameInstant: ReceivingCommandFacts = {
      ...FACTS,
      occurredAt: new Date('2026-08-04T05:00:00-05:00'),
    };
    expect(receivingRequestHash(sameInstant)).toBe(receivingRequestHash(FACTS));
  });

  it('does not depend on a separate Date object for the same instant', () => {
    expect(
      receivingRequestHash({ ...FACTS, occurredAt: new Date(FACTS.occurredAt.getTime()) }),
    ).toBe(receivingRequestHash(FACTS));
  });
});

describe('every business fact changes the hash', () => {
  const original = receivingRequestHash(FACTS);

  it.each<[string, Partial<ReceivingCommandFacts>]>([
    ['variant', { variantId: OTHER_ID }],
    ['location', { locationId: OTHER_ID }],
    ['quantity', { quantity: 13 }],
    ['occurred-at', { occurredAt: new Date('2026-08-04T10:00:01.000Z') }],
    ['actor', { actorId: OTHER_ID }],
  ])('a different %s is a different command', (_what, change) => {
    expect(receivingRequestHash({ ...FACTS, ...change })).not.toBe(original);
  });

  it('separates receiving from any other workflow that posts a receipt', () => {
    const fields = receivingCanonicalFields(FACTS);
    expect(fields.workflow).toBe(RECEIVING_OPERATION_TYPE);
    expect(canonicalRequestHash({ ...fields, workflow: 'inventory.opening_stock' })).not.toBe(
      original,
    );
  });
});

describe('nothing the server generated is in the hash', () => {
  it('covers exactly the six business fields', () => {
    // Read from the canonical field set rather than from the digest, because
    // "which fields" is the reviewable fact. A movement id or a recorded time
    // here would make every retry differ from the attempt it repeats.
    expect(Object.keys(receivingCanonicalFields(FACTS)).sort()).toEqual([
      'actorId',
      'locationId',
      'occurredAt',
      'quantity',
      'variantId',
      'workflow',
    ]);
  });

  it('does not include the operation id', () => {
    // The hash is stored *against* the operation id. Hashing the id too would
    // make every command unique, and the comparison could never fail.
    expect(Object.keys(receivingCanonicalFields(FACTS))).not.toContain('operationId');
  });
});

describe('the canonical form itself', () => {
  it('sorts fields by name, one per line, tagged by type', () => {
    expect(canonicalRequestForm({ b: 2, a: 'x', c: true, d: null })).toBe(
      ['a=s:x', 'b=n:2', 'c=b:true', 'd=z:'].join('\n'),
    );
  });

  it('keeps a number and its decimal string apart', () => {
    // A client that starts sending a quantity as a string is sending a
    // different command, not the same one differently spelled.
    expect(canonicalRequestHash({ quantity: 12 })).not.toBe(
      canonicalRequestHash({ quantity: '12' }),
    );
  });

  it('treats an absent field and an explicit null differently from a blank string', () => {
    expect(canonicalRequestHash({ note: null })).not.toBe(canonicalRequestHash({ note: '' }));
    expect(canonicalRequestHash({ note: null })).not.toBe(canonicalRequestHash({}));
  });

  it('cannot be fooled by values that contain its separators', () => {
    // Without escaping, `{a: 'x', b: 'y'}` and `{a: 'x\nb=s:y'}` would be the
    // same bytes and the same digest.
    expect(canonicalRequestHash({ a: 'x', b: 'y' })).not.toBe(
      canonicalRequestHash({ a: 'x\nb=s:y' }),
    );
    expect(canonicalRequestHash({ a: 'x=y' })).not.toBe(canonicalRequestHash({ 'a=x': 'y' }));
    expect(canonicalRequestHash({ a: '\\e' })).not.toBe(canonicalRequestHash({ a: '=' }));
  });

  it('refuses a value with no canonical decimal form', () => {
    // A stable digest of "NaN" would be perfectly reproducible and completely
    // meaningless.
    expect(() => canonicalRequestHash({ quantity: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalRequestHash({ quantity: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('does not distinguish negative zero from zero', () => {
    expect(canonicalRequestHash({ n: -0 })).toBe(canonicalRequestHash({ n: 0 }));
  });
});
