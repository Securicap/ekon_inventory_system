import { describe, expect, it } from 'vitest';
import { localDateTimeToIso, toLocalDateTimeInputValue } from '../src/lib/businessTime.js';

/**
 * Business time: when stock physically moved, as a shop laptop states it.
 *
 * One conversion for every inventory workflow. Receiving books in a delivery
 * and removal records a sale, and if the two rounded a local time to an instant
 * differently, the same afternoon would be two different moments in a permanent
 * ledger.
 *
 * The time-zone tests derive their expectations through the same `Date`
 * semantics the browser uses rather than hard-coding an offset, so they hold
 * wherever they are run.
 */

describe('local time to an instant', () => {
  it('means the local time, and states it in UTC', () => {
    const value = '2026-08-04T14:30';
    expect(localDateTimeToIso(value)).toBe(new Date(value).toISOString());
  });

  it('round-trips whatever the control was prefilled with', () => {
    const now = new Date();
    const value = toLocalDateTimeInputValue(now);
    const iso = localDateTimeToIso(value);
    expect(iso).not.toBeNull();
    expect(toLocalDateTimeInputValue(new Date(iso!))).toBe(value);
  });

  it('writes the control value in local time, never in UTC', () => {
    // The distinction only shows where the two differ, which is everywhere the
    // shop is. Compared against the local getters rather than a fixed offset.
    const date = new Date(2026, 7, 4, 14, 30);
    expect(toLocalDateTimeInputValue(date)).toBe('2026-08-04T14:30');
  });

  it('pads every part, so the control accepts it', () => {
    expect(toLocalDateTimeInputValue(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02T03:04');
  });

  it('refuses a date that does not exist', () => {
    // `new Date('2026-02-31T10:00')` rolls forward to 3 March rather than
    // failing, so without the round-trip check a typo would be sent as a real
    // and wrong business time.
    expect(localDateTimeToIso('2026-02-31T10:00')).toBeNull();
    expect(localDateTimeToIso('2025-02-29T10:00')).toBeNull();
  });

  it('accepts a leap day in a leap year', () => {
    expect(localDateTimeToIso('2028-02-29T10:00')).not.toBeNull();
  });

  it('refuses anything that is not a local date and time', () => {
    for (const value of ['', 'yesterday', '2026-08-04', '04/08/2026 14:30', '2026-08-04T14']) {
      expect(localDateTimeToIso(value), value).toBeNull();
    }
  });
});
