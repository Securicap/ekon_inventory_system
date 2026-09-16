import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  normalizeCurrency,
  parseMoneyAmount,
  toMoneyInputValue,
} from '../src/lib/money.js';

/**
 * The one conversion in the frontend that must not be written the obvious way.
 *
 * A price leaves the browser as an integer count of minor units, and the
 * tempting `Number(input) * 100` is wrong for inputs a shop types every day.
 * These tests exist to keep the string implementation, so they name the amounts
 * that break the arithmetic one rather than only the round ones.
 */

describe('parseMoneyAmount', () => {
  it('reads whole and fractional amounts', () => {
    expect(parseMoneyAmount('7500')).toEqual({ ok: true, amountMinor: 750000 });
    expect(parseMoneyAmount('7500.50')).toEqual({ ok: true, amountMinor: 750050 });
    expect(parseMoneyAmount('0.05')).toEqual({ ok: true, amountMinor: 5 });
    expect(parseMoneyAmount('0')).toEqual({ ok: true, amountMinor: 0 });
  });

  it('keeps every centime of an amount floating point would lose', () => {
    // `7500.55 * 100` is 750054.99999999999 in JavaScript, and rounding that
    // is a habit that loses a centime somewhere else. Read as digits, it is
    // exactly what somebody typed — which is the entire point of the module.
    expect(parseMoneyAmount('7500.55')).toEqual({ ok: true, amountMinor: 750055 });
    expect(parseMoneyAmount('1.10')).toEqual({ ok: true, amountMinor: 110 });
    expect(parseMoneyAmount('4.35')).toEqual({ ok: true, amountMinor: 435 });
    expect(parseMoneyAmount('1.005')).toEqual({ ok: false, error: 'malformed' });
  });

  it('pads a short fraction rather than reading it as units', () => {
    // `7500.5` is seven thousand five hundred gourdes and fifty centimes, not
    // five. The pad is on the right, and this is where that is decided.
    expect(parseMoneyAmount('7500.5')).toEqual({ ok: true, amountMinor: 750050 });
    expect(parseMoneyAmount('7500.')).toEqual({ ok: true, amountMinor: 750000 });
  });

  it('accepts a comma as the decimal separator', () => {
    // Both appear on the keyboards this is typed on, and neither is a mistake.
    expect(parseMoneyAmount('7500,50')).toEqual({ ok: true, amountMinor: 750050 });
  });

  it('refuses a group separator rather than stripping it', () => {
    // `1,500` is fifteen hundred to one reader and one point five to another.
    // A price is not a place to guess which was meant.
    expect(parseMoneyAmount('1,500.00')).toEqual({ ok: false, error: 'malformed' });
    expect(parseMoneyAmount('1 500')).toEqual({ ok: false, error: 'malformed' });
  });

  it('refuses what is not an amount at all', () => {
    expect(parseMoneyAmount('')).toEqual({ ok: false, error: 'malformed' });
    expect(parseMoneyAmount('abc')).toEqual({ ok: false, error: 'malformed' });
    expect(parseMoneyAmount('-5')).toEqual({ ok: false, error: 'malformed' });
    expect(parseMoneyAmount('1e5')).toEqual({ ok: false, error: 'malformed' });
  });

  it('trims surrounding space, which is what a paste leaves behind', () => {
    expect(parseMoneyAmount('  7500.50 ')).toEqual({ ok: true, amountMinor: 750050 });
  });

  it('refuses an amount too large to stay exact, rather than rounding it', () => {
    // Past the safe integer range the count of centimes stops being the count
    // of centimes. Saying so beats storing a number that is almost the price.
    const result = parseMoneyAmount('99999999999999.99');
    expect(result).toEqual({ ok: false, error: 'tooLarge' });
  });
});

describe('toMoneyInputValue', () => {
  it('puts a stored amount back the way it was typed', () => {
    expect(toMoneyInputValue(750050)).toBe('7500.50');
    expect(toMoneyInputValue(5)).toBe('0.05');
    expect(toMoneyInputValue(0)).toBe('0.00');
  });

  it('round-trips through the parse without drifting', () => {
    for (const amountMinor of [0, 5, 110, 435, 750055, 999999999]) {
      expect(parseMoneyAmount(toMoneyInputValue(amountMinor))).toEqual({ ok: true, amountMinor });
    }
  });
});

describe('formatMoney', () => {
  it('always says which money it is', () => {
    // This shop buys in one currency and sells in another. A bare number, or a
    // bare `$`, is the one thing a price must never be.
    expect(formatMoney({ amountMinor: 750000, currency: 'HTG' })).toContain('HTG');
    expect(formatMoney({ amountMinor: 40000, currency: 'USD' })).toContain('USD');
  });

  it('shows the minor units it was given', () => {
    expect(formatMoney({ amountMinor: 5, currency: 'HTG' })).toContain('0,05');
  });

  it('prints an unrecognised code plainly rather than throwing', () => {
    // The contract accepts any three-letter code on purpose — which currencies
    // the business takes is an operational question, not a schema one.
    expect(formatMoney({ amountMinor: 1234, currency: 'ZZZ' })).toContain('ZZZ');
    expect(formatMoney({ amountMinor: 1234, currency: 'ZZZ' })).toContain('12');
  });
});

describe('normalizeCurrency', () => {
  it('uppercases a code typed in a hurry', () => {
    // `htg` is not a different currency from `HTG`.
    expect(normalizeCurrency('htg')).toBe('HTG');
    expect(normalizeCurrency(' usd ')).toBe('USD');
  });

  it('refuses what is not a three-letter code', () => {
    // `US$` and `dollars` are different currencies as far as anyone can tell,
    // and the schema would reject them after a round trip anyway.
    expect(normalizeCurrency('US$')).toBeNull();
    expect(normalizeCurrency('dollars')).toBeNull();
    expect(normalizeCurrency('HT')).toBeNull();
    expect(normalizeCurrency('')).toBeNull();
  });
});
