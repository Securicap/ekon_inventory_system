import { describe, expect, it } from 'vitest';
import {
  formatDelta,
  isReversible,
  movementHeadlineKey,
  movementTypeKey,
  reasonKey,
} from '../src/lib/movements.js';
import { movementFixture } from './helpers/fixtures.js';

/**
 * Turning the ledger's own words into the shop's.
 *
 * Nothing in this module is ever sent to the server: a reason chosen from a
 * list goes back as the code it always was, and a movement type is never sent
 * at all because the server derives every one of them.
 */

describe('movementTypeKey', () => {
  it('has a word for every type the vocabulary defines', () => {
    // Exhaustive rather than a lookup with a fallback: adding a type should
    // fail to compile until somebody decides what a shop calls it.
    for (const type of [
      'RECEIPT',
      'ISSUE',
      'ADJUSTMENT_IN',
      'ADJUSTMENT_OUT',
      'COUNT_RECONCILIATION',
      'REVERSAL',
    ] as const) {
      expect(movementTypeKey(type)).toBeTruthy();
    }
  });
});

describe('reasonKey', () => {
  it('reads all three vocabularies out of the one column', () => {
    // Removal's, adjustment's and reconciliation's reasons all live in the
    // ledger's single `reason_code`, and history reads them without knowing
    // which workflow wrote the row.
    expect(reasonKey('SOLD')).toBe('reason.sold');
    expect(reasonKey('MISSED_MOVEMENT')).toBe('reason.missedMovement');
    expect(reasonKey('SHRINKAGE')).toBe('reason.shrinkage');
  });

  it('gives one word to the codes that appear in two vocabularies', () => {
    // `DATA_ENTRY_ERROR` means the same thing wherever it was written.
    expect(reasonKey('DATA_ENTRY_ERROR')).toBe('reason.dataEntryError');
    expect(reasonKey('OTHER')).toBe('reason.other');
  });

  it('answers null for a movement that carries no reason', () => {
    expect(reasonKey(null)).toBeNull();
  });

  it('answers null for a code this build has never heard of', () => {
    // The caller shows the code itself rather than nothing: a reason from a
    // newer server is still evidence.
    expect(reasonKey('SPOILED')).toBeNull();
  });
});

describe('movementHeadlineKey', () => {
  it('leads a sale with its reason rather than its mechanism', () => {
    // Sold, broken and taken for the shop's own use are three different things,
    // and the ledger keeps a reason column precisely to tell them apart.
    const sale = movementFixture({
      movementType: 'ISSUE',
      quantityDelta: -2,
      quantityBefore: 5,
      reasonCode: 'SOLD',
    });
    expect(movementHeadlineKey(sale)).toBe('reason.sold');
  });

  it('falls back to the type when an issue carries an unfamiliar reason', () => {
    const issue = movementFixture({
      movementType: 'ISSUE',
      quantityDelta: -1,
      quantityBefore: 5,
      reasonCode: 'SPOILED',
    });
    expect(movementHeadlineKey(issue)).toBe('movement.issue');
  });

  it('leads everything else with its type', () => {
    // An adjustment's reason explains a correction rather than naming an event,
    // and a reconciliation's names a conclusion — both belong beside the
    // movement, not instead of it.
    const reconciliation = movementFixture({
      movementType: 'COUNT_RECONCILIATION',
      quantityDelta: -1,
      quantityBefore: 7,
      reasonCode: 'SHRINKAGE',
    });
    expect(movementHeadlineKey(reconciliation)).toBe('movement.countReconciliation');
  });
});

describe('formatDelta', () => {
  it('signs both directions, with a real minus sign', () => {
    // A hyphen next to a number reads as a dash in some fonts. This is the
    // character that means "less".
    expect(formatDelta(4)).toBe('+4');
    expect(formatDelta(-1)).toBe('−1');
    expect(formatDelta(-1).charCodeAt(0)).toBe(0x2212);
  });
});

describe('isReversible', () => {
  it('allows an ordinary movement', () => {
    expect(isReversible(movementFixture())).toBe(true);
  });

  it('refuses a reversal of a reversal', () => {
    // The ledger's own rule (INV-2).
    const reversal = movementFixture({
      movementType: 'REVERSAL',
      quantityDelta: -10,
      quantityBefore: 10,
      reversesMovementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01',
    });
    expect(isReversible(reversal)).toBe(false);
  });

  it('refuses a movement that has already been reversed', () => {
    const reversed = movementFixture({
      reversedByMovementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e09',
    });
    expect(isReversible(reversed)).toBe(false);
  });

  it('does not try to predict the stock floor', () => {
    // Whether reversing a receipt would take the shelf below zero depends on
    // the current balance, which the browser does not have and must not guess
    // at. That refusal belongs to the server.
    const bigReceipt = movementFixture({ quantityDelta: 1000, quantityBefore: 0 });
    expect(isReversible(bigReceipt)).toBe(true);
  });
});
