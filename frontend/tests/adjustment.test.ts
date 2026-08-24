import { describe, expect, it } from 'vitest';
import { MAX_MOVEMENT_QUANTITY } from '@ekon/shared';
import {
  ADJUSTMENT_DIRECTION_KEYS,
  ADJUSTMENT_REASON_KEYS,
  emptyAdjustment,
  toQuantityDelta,
  validateAdjustmentForm,
  type AdjustmentFormValues,
} from '../src/lib/adjustment.js';

/**
 * Correcting a recorded quantity.
 *
 * The contract takes a signed `quantityDelta`, which is the right shape for a
 * ledger command and the wrong shape for a form: somebody at a counter should
 * not have to know that a minus sign is how you say "we have fewer than it
 * says". Exactly one place knows that *Decrease* means a negative delta, and
 * this is the file that proves it is only one place.
 */

function form(values: Partial<AdjustmentFormValues> = {}): AdjustmentFormValues {
  return { ...emptyAdjustment('2026-08-05T09:15'), ...values };
}

describe('emptyAdjustment', () => {
  it('opens on decrease, which is what a wrong number usually is', () => {
    // The overwhelming case is a shelf holding fewer than the record claims.
    expect(emptyAdjustment('2026-08-05T09:15').direction).toBe('decrease');
  });

  it('chooses no reason, because guessing one would be putting words in a mouth', () => {
    expect(emptyAdjustment('2026-08-05T09:15').reason).toBe('');
  });
});

describe('toQuantityDelta', () => {
  it('turns a direction and a magnitude into the signed number', () => {
    expect(toQuantityDelta(form({ direction: 'decrease', quantity: '3' }))).toBe(-3);
    expect(toQuantityDelta(form({ direction: 'increase', quantity: '3' }))).toBe(3);
  });

  it('refuses to invent a delta from an unusable field', () => {
    // The alternative is sending a `NaN` to the server.
    expect(toQuantityDelta(form({ quantity: '' }))).toBeNull();
    expect(toQuantityDelta(form({ quantity: 'abc' }))).toBeNull();
    expect(toQuantityDelta(form({ quantity: '2.5' }))).toBeNull();
    expect(toQuantityDelta(form({ quantity: '0' }))).toBeNull();
    expect(toQuantityDelta(form({ quantity: '-3' }))).toBeNull();
  });

  it('never produces a delta of zero', () => {
    // A movement of nothing is not a correction, and the ledger refuses it.
    for (const quantity of ['0', '-0', '0.0']) {
      expect(toQuantityDelta(form({ quantity }))).not.toBe(0);
    }
  });
});

describe('validateAdjustmentForm', () => {
  const complete = { quantity: '3', reason: 'DATA_ENTRY_ERROR' } as const;

  it('accepts a finished correction', () => {
    expect(validateAdjustmentForm(form(complete))).toEqual({});
  });

  it('asks for a quantity', () => {
    expect(validateAdjustmentForm(form({ ...complete, quantity: '' })).quantity).toBe(
      'adjust.quantityRequired',
    );
  });

  it('refuses correcting by nothing', () => {
    // "Correct it by zero" is a form somebody has not finished filling in
    // rather than a command worth sending.
    expect(validateAdjustmentForm(form({ ...complete, quantity: '0' })).quantity).toBe(
      'adjust.quantityInvalid',
    );
  });

  it('bounds the magnitude by the shared maximum', () => {
    const tooMany = String(MAX_MOVEMENT_QUANTITY + 1);
    expect(validateAdjustmentForm(form({ ...complete, quantity: tooMany })).quantity).toBe(
      'adjust.quantityTooLarge',
    );
  });

  it('requires a reason, and a note for OTHER', () => {
    expect(validateAdjustmentForm(form({ quantity: '3' })).reason).toBe('adjust.reasonRequired');
    expect(validateAdjustmentForm(form({ quantity: '3', reason: 'OTHER' })).note).toBe(
      'adjust.noteRequired',
    );
  });

  it('requires the time the correction is about', () => {
    expect(validateAdjustmentForm(form({ ...complete, occurredAtLocal: '' })).occurredAtLocal).toBe(
      'adjust.timeRequired',
    );
  });

  it('says nothing about the stock floor, which it cannot know', () => {
    // Whether the shelf can absorb a decrease depends on a balance this form
    // does not hold. It comes back as `INSUFFICIENT_STOCK`.
    const huge = validateAdjustmentForm(form({ ...complete, quantity: '99999' }));
    expect(huge.quantity).not.toBe('adjust.insufficient');
  });
});

describe('the vocabularies', () => {
  it('names both directions', () => {
    expect(Object.keys(ADJUSTMENT_DIRECTION_KEYS).sort()).toEqual(['decrease', 'increase']);
  });

  it('offers the two real causes of a wrong number, plus the honest escape', () => {
    expect(Object.keys(ADJUSTMENT_REASON_KEYS).sort()).toEqual([
      'DATA_ENTRY_ERROR',
      'MISSED_MOVEMENT',
      'OTHER',
    ]);
  });
});
