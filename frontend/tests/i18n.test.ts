import { describe, expect, it } from 'vitest';
import fr from '../src/i18n/fr.json';
import ht from '../src/i18n/ht.json';
import { formatShopTime, LOCALES, translate } from '../src/i18n/index.js';

describe('i18n', () => {
  it('has the same keys in every locale', () => {
    // A missing key means a shop screen silently falls back to Creole for the
    // owner, or shows a raw key. Catch it in CI, not in the shop.
    expect(Object.keys(fr).sort()).toEqual(Object.keys(ht).sort());
  });

  it('has no empty translations', () => {
    for (const locale of LOCALES) {
      const catalog = locale === 'ht' ? ht : fr;
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${locale}.${key} is empty`).not.toBe('');
      }
    }
  });

  it('defaults to Haitian Creole for employee-facing text', () => {
    expect(translate('ht', 'connectivity.offline')).toContain('Koneksyon');
  });

  it('interpolates variables', () => {
    expect(translate('ht', 'error.requestId', { requestId: 'abc123' })).toContain('abc123');
  });

  it('renders timestamps in shop time for every locale', () => {
    // 2026-08-02T12:00Z is 08:00 in Port-au-Prince (UTC-4 in August).
    const utcNoon = '2026-08-02T12:00:00.000Z';
    expect(formatShopTime(utcNoon, 'ht')).toContain('08:00');
    expect(formatShopTime(utcNoon, 'fr')).toContain('08:00');
  });
});
