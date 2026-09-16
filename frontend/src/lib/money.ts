import type { Money } from '@ekon/shared';

/**
 * Money at the edge of the browser: what somebody types, and what the contract
 * stores.
 *
 * The backend stores an integer count of minor units plus an explicit currency
 * (INV-17), and it is right to. Nobody at a counter types `750000` to mean
 * 7,500 gourdes, so this converts — and the conversion is the whole reason this
 * file exists, because the obvious way to write it is wrong.
 *
 * **No floating-point arithmetic anywhere in the parse.** `7500.55 * 100` is
 * `750054.99999999999` in JavaScript, and `Math.round` would paper over that
 * for most inputs and lose a centime for some. The digits are read as *text*,
 * padded, and joined — so the integer that reaches the server is the one the
 * person typed, every time.
 *
 * Display is a different matter: `Intl.NumberFormat` over a number is fine
 * because nothing is stored from it.
 */

/**
 * How many minor units make one major unit.
 *
 * Two, for every currency this shop deals in, and stated once rather than
 * scattered. It is deliberately **not** derived from the currency code: a table
 * of exponents per ISO code would be a claim about currencies nobody here uses,
 * and the day one of them matters it should be a decision somebody takes rather
 * than a lookup that was already there.
 */
const MINOR_UNIT_DIGITS = 2;

/** `7,500.00` and `7 500,00` are both what a shop laptop produces. */
const AMOUNT_PATTERN = /^\d{1,15}([.,]\d{0,2})?$/;

export type MoneyParseError = 'malformed' | 'tooLarge';

export type MoneyParseResult =
  { ok: true; amountMinor: number } | { ok: false; error: MoneyParseError };

/**
 * `"7500.50"` → `750050`.
 *
 * Accepts a comma or a dot as the decimal separator, because both appear on the
 * keyboards this is typed on and neither is a mistake. Group separators are
 * refused rather than stripped: `1,500` is one thousand five hundred to one
 * reader and one point five to another, and a price is not a place to guess.
 *
 * A blank string is **not** parsed here — it is an absent price, which is a real
 * and ordinary state (`null` in the contract, meaning nobody has established
 * one). The caller decides that before asking.
 */
export function parseMoneyAmount(input: string): MoneyParseResult {
  const trimmed = input.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) return { ok: false, error: 'malformed' };

  const [major, minor = ''] = trimmed.split(/[.,]/);
  // String padding, not multiplication: the digits somebody typed are the
  // digits that get stored.
  const digits = `${major}${minor.padEnd(MINOR_UNIT_DIGITS, '0')}`;
  const amountMinor = Number(digits);

  // Beyond this the integer stops being exact, and a price that cannot be
  // represented must not be silently rounded into one that can.
  if (!Number.isSafeInteger(amountMinor)) return { ok: false, error: 'tooLarge' };

  return { ok: true, amountMinor };
}

/** `750050` → `"7500.50"`, for putting a stored amount back in an input. */
export function toMoneyInputValue(amountMinor: number): string {
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(MINOR_UNIT_DIGITS + 1, '0');
  const major = digits.slice(0, digits.length - MINOR_UNIT_DIGITS);
  const minor = digits.slice(digits.length - MINOR_UNIT_DIGITS);
  return `${negative ? '-' : ''}${major}.${minor}`;
}

/**
 * A stored amount, as it is read: `HTG 7,500.00`.
 *
 * The currency code is shown rather than a symbol. This shop buys in one
 * currency and sells in another routinely (INV-17), so a bare `$` or a bare
 * number would be the one thing a price must never be — ambiguous about which
 * money it is.
 *
 * `Intl` is asked to format the code and falls back to printing it plainly if
 * it does not recognise one, which is possible: the contract accepts any
 * three-letter code, deliberately, because which currencies the business
 * accepts is an operational question and not a schema one.
 */
export function formatMoney(money: Money, locale = 'fr-HT'): string {
  const amount = money.amountMinor / 10 ** MINOR_UNIT_DIGITS;

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: money.currency,
      currencyDisplay: 'code',
    }).format(amount);
  } catch {
    return `${money.currency} ${amount.toFixed(MINOR_UNIT_DIGITS)}`;
  }
}

/**
 * A currency code as the contract requires it: three letters, uppercase.
 *
 * Uppercased here rather than refused, because `htg` typed in a hurry is not a
 * different currency — but the shape is checked, because `US$` and `dollars`
 * are, and the schema would reject them after a round trip.
 */
export function normalizeCurrency(input: string): string | null {
  const code = input.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}
