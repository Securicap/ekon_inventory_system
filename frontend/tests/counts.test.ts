import { describe, expect, it } from 'vitest';
import { MAX_MOVEMENT_QUANTITY } from '@ekon/shared';
import {
  COUNT_REASON_KEYS,
  COUNT_STATUS_KEYS,
  emptyCount,
  formatVariance,
  reconciliationMessageKey,
  validateCountForm,
  validateReconcileForm,
  type RecordCountFormValues,
} from '../src/lib/counts.js';
import { countFixture } from './helpers/fixtures.js';

/**
 * The count rules, without the markup.
 *
 * > **A count observes. Investigation explains. Reconciliation changes stock.**
 *
 * Nothing in this module computes a balance and nothing turns a variance into a
 * decision, and these tests are how it stays that way.
 */

function form(values: Partial<RecordCountFormValues> = {}): RecordCountFormValues {
  return { ...emptyCount('2026-08-05T09:15'), ...values };
}

const FILLED = {
  variantId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4af1',
  locationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01',
};

describe('validateCountForm', () => {
  it('accepts zero, which is the count that matters most', () => {
    // An empty shelf is exactly the observation somebody skips when the form
    // looks like it wants a positive number.
    expect(validateCountForm(form({ ...FILLED, countedQuantity: '0' }))).toEqual({});
  });

  it('tells an empty field from a zero', () => {
    expect(validateCountForm(form({ ...FILLED, countedQuantity: '' })).countedQuantity).toBe(
      'counts.quantityRequired',
    );
  });

  it('refuses a negative count and a fractional one', () => {
    expect(validateCountForm(form({ ...FILLED, countedQuantity: '-1' })).countedQuantity).toBe(
      'counts.quantityInvalid',
    );
    expect(validateCountForm(form({ ...FILLED, countedQuantity: '2.5' })).countedQuantity).toBe(
      'counts.quantityInvalid',
    );
  });

  it('bounds the count by the shared maximum', () => {
    const tooMany = String(MAX_MOVEMENT_QUANTITY + 1);
    expect(validateCountForm(form({ ...FILLED, countedQuantity: tooMany })).countedQuantity).toBe(
      'counts.quantityTooLarge',
    );
  });

  it('asks for the item, the shelf and the time', () => {
    const errors = validateCountForm(form({ countedQuantity: '6', countedAtLocal: '' }));
    expect(errors.variantId).toBe('counts.itemRequired');
    expect(errors.locationId).toBe('counts.locationRequired');
    expect(errors.countedAtLocal).toBe('counts.timeRequired');
  });

  it('says nothing about an expected quantity, because the form never has one', () => {
    // The server reads it inside the recording transaction. A browser that
    // could supply it could manufacture any variance it liked.
    const errors = validateCountForm(form({ ...FILLED, countedQuantity: '6' }));
    expect(Object.keys(errors)).toEqual([]);
  });
});

describe('validateReconcileForm', () => {
  it('requires a reason', () => {
    // A stock change nobody explained is what the count principle exists to
    // prevent.
    expect(validateReconcileForm({ reason: '', note: '' }).reason).toBe('counts.reasonRequired');
  });

  it('demands a note for OTHER, which explains nothing on its own', () => {
    expect(validateReconcileForm({ reason: 'OTHER', note: '   ' }).note).toBe(
      'counts.noteRequired',
    );
    expect(validateReconcileForm({ reason: 'OTHER', note: 'Bwat ki tonbe' })).toEqual({});
  });

  it('asks for no note when the reason already says something', () => {
    expect(validateReconcileForm({ reason: 'SHRINKAGE', note: '' })).toEqual({});
  });
});

describe('reconciliationMessageKey', () => {
  it('names the change, never the destination', () => {
    // *This will adjust inventory by −1*, and never *this will set inventory to
    // 6*. Six was true when the shelf was walked; if a unit sold since, the
    // shelf now holds five and accepting a difference of one leaves four.
    const short = countFixture({ expectedQuantity: 7, countedQuantity: 6 });
    const over = countFixture({ expectedQuantity: 4, countedQuantity: 6 });

    expect(reconciliationMessageKey(short)).toBe('counts.willDecrease');
    expect(reconciliationMessageKey(over)).toBe('counts.willIncrease');
  });
});

describe('formatVariance', () => {
  it('signs a difference and leaves a match plain', () => {
    expect(formatVariance(2)).toBe('+2');
    expect(formatVariance(-1)).toBe('−1');
    // Zero is a match, and `+0` would read as a difference of nothing.
    expect(formatVariance(0)).toBe('0');
  });

  it('uses a real minus sign', () => {
    expect(formatVariance(-1).charCodeAt(0)).toBe(0x2212);
  });
});

describe('the vocabularies', () => {
  it('has a word for every count status', () => {
    expect(Object.keys(COUNT_STATUS_KEYS).sort()).toEqual(['MATCHED', 'OPEN', 'RECONCILED']);
  });

  it('has seven reasons, and none of them is "the count was wrong"', () => {
    // A mistaken count is corrected by counting again, not by accepting a
    // difference nobody believes in.
    expect(Object.keys(COUNT_REASON_KEYS)).toHaveLength(7);
    expect(Object.keys(COUNT_REASON_KEYS)).not.toContain('MISCOUNT');
  });
});
