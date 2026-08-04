import { describe, expect, it } from 'vitest';
import {
  activeLocations,
  activeVariantChoices,
  formatVariantLabel,
  localDateTimeToIso,
  preferredLocationId,
  toLocalDateTimeInputValue,
  validateReceivingForm,
} from '../src/lib/receiving.js';
import { newOperationId } from '../src/lib/operations.js';
import { locationFixture, productFixture } from './helpers/fixtures.js';

/**
 * The decisions behind the receiving form, tested away from the DOM: which
 * items may be received, what one is called, what a valid receipt looks like,
 * and how a local date and time becomes an instant.
 *
 * The time-zone tests derive their expectations through the same `Date`
 * semantics the browser uses rather than hard-coding an offset, so they hold
 * wherever they are run.
 */

describe('which variants may be received', () => {
  it('offers an active variant of an active product', () => {
    const choices = activeVariantChoices([productFixture({ name: 'Diri' })]);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.label).toContain('Diri');
  });

  it('offers nothing from a retired product', () => {
    expect(activeVariantChoices([productFixture({ isActive: false })])).toEqual([]);
  });

  it('offers nothing from a discontinued variant of a product still sold', () => {
    expect(activeVariantChoices([productFixture({ variantIsActive: false })])).toEqual([]);
  });

  it('sorts the choices so the list does not depend on creation order', () => {
    const choices = activeVariantChoices([
      productFixture({ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02', name: 'Zoranj' }),
      productFixture({ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03', name: 'Ayil' }),
    ]);
    expect(choices.map((choice) => choice.label.split(' ')[0])).toEqual(['Ayil', 'Zoranj']);
  });
});

describe('naming a variant', () => {
  it('reads as product, attributes, and SKU', () => {
    expect(
      formatVariantLabel(
        'Chemiz',
        [
          { name: 'gwosè', value: 'Gran' },
          { name: 'koulè', value: 'Ble' },
        ],
        'EKN-AB12CD34',
      ),
    ).toBe('Chemiz — gwosè: Gran, koulè: Ble — EKN-AB12CD34');
  });

  it('leaves out an empty attribute list rather than an empty gap', () => {
    expect(formatVariantLabel('Lwil', [], 'EKN-EF56GH78')).toBe('Lwil — EKN-EF56GH78');
  });
});

describe('which location a form starts on', () => {
  it('drops inactive locations from the choices', () => {
    const closed = locationFixture({ name: 'Fèmen', isActive: false, isDefault: false });
    const open = locationFixture({ name: 'Louvri' });
    expect(activeLocations([closed, open]).map((location) => location.name)).toEqual(['Louvri']);
  });

  it('prefers the default location', () => {
    const other = locationFixture({ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b09', isDefault: false });
    const main = locationFixture({ isDefault: true });
    expect(preferredLocationId([other, main])).toBe(main.id);
  });

  it('takes the only location when there is no default', () => {
    const only = locationFixture({ isDefault: false });
    expect(preferredLocationId([only])).toBe(only.id);
  });

  it('chooses nothing when several could be meant', () => {
    expect(
      preferredLocationId([
        locationFixture({ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b07', isDefault: false }),
        locationFixture({ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b08', isDefault: false }),
      ]),
    ).toBeNull();
  });

  it('chooses nothing when there is nowhere to receive', () => {
    expect(preferredLocationId([])).toBeNull();
  });
});

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

describe('validating a receipt before it is sent', () => {
  const valid = {
    variantId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01',
    locationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01',
    quantity: '12',
    occurredAtLocal: '2026-08-04T14:30',
  };

  it('accepts a complete receipt', () => {
    expect(validateReceivingForm(valid)).toEqual({});
  });

  it('requires an item and a location', () => {
    expect(validateReceivingForm({ ...valid, variantId: '' }).variantId).toBe(
      'receiving.variantRequired',
    );
    expect(validateReceivingForm({ ...valid, locationId: '' }).locationId).toBe(
      'receiving.locationRequired',
    );
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['not a number', 'twelve'],
  ])('refuses a %s quantity', (_label, quantity) => {
    expect(validateReceivingForm({ ...valid, quantity }).quantity).toBe(
      'receiving.quantityInvalid',
    );
  });

  it('distinguishes a missing quantity from an impossible one', () => {
    expect(validateReceivingForm({ ...valid, quantity: '   ' }).quantity).toBe(
      'receiving.quantityRequired',
    );
  });

  it('refuses a quantity the ledger could not store', () => {
    expect(validateReceivingForm({ ...valid, quantity: '2147483648' }).quantity).toBe(
      'receiving.quantityTooLarge',
    );
    expect(validateReceivingForm({ ...valid, quantity: '2147483647' }).quantity).toBeUndefined();
  });

  it('requires an arrival time that exists', () => {
    expect(validateReceivingForm({ ...valid, occurredAtLocal: '' }).occurredAtLocal).toBe(
      'receiving.occurredAtRequired',
    );
    expect(
      validateReceivingForm({ ...valid, occurredAtLocal: '2026-02-31T10:00' }).occurredAtLocal,
    ).toBe('receiving.occurredAtInvalid');
  });

  it('does not refuse an arrival time in the future', () => {
    // A shop laptop whose clock is a few minutes fast must not block a delivery
    // that is physically on the counter.
    expect(validateReceivingForm({ ...valid, occurredAtLocal: '2099-01-01T09:00' })).toEqual({});
  });
});

describe('operation ids', () => {
  it('are UUIDv7, and a different one every time', () => {
    const first = newOperationId();
    const second = newOperationId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second).not.toBe(first);
  });

  it('are not written anywhere', () => {
    newOperationId();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
