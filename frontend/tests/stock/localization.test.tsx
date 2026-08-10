import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fr from '../../src/i18n/fr.json';
import ht from '../../src/i18n/ht.json';
import { translate, type MessageKey } from '../../src/i18n/index.js';
import { json } from '../helpers/fetchMock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import { BALANCES_ROUTE, openStock, refreshButton, typeSearch } from '../helpers/stock.js';

/**
 * Every string the stock screen added exists in both languages, and the screen
 * reads its text from the catalogue rather than from the component.
 *
 * Employees read this in Haitian Creole at the counter and the owner reads
 * French from abroad. This is the screen somebody checks before telling a
 * customer whether there is any rice, so a sentence that only exists in one
 * language is a question that can only be answered in one language.
 *
 * The application renders in Creole today because there is no language
 * selector; French is asserted through the catalogue, which is what the
 * selector will read when it arrives.
 */

const KEYS_ADDED_BY_CURRENT_STOCK = [
  'stock.title',
  'stock.description',
  'stock.total',
  'stock.columnItem',
  'stock.columnLocations',
  'stock.resultsOne',
  'stock.results',
  'stock.searchLabel',
  'stock.searchPlaceholder',
  'stock.noVariants',
  'stock.noLocations',
  'stock.noMatches',
  'stock.refresh',
  'stock.refreshing',
] as const satisfies readonly MessageKey[];

/** Reused rather than re-translated: the same marker, said the same way. */
const KEYS_REUSED_BY_CURRENT_STOCK = [
  'nav.stock',
  'catalog.sku',
  'catalog.columnProduct',
  'catalog.columnVariant',
  'catalog.noAttributes',
  'inventory.defaultLocation',
  'status.loading',
  'error.forbidden',
  'error.network',
] as const satisfies readonly MessageKey[];

const RICE = balanceFixture({
  productName: 'Diri',
  sku: 'EKN-AB12CD34',
  attributes: [{ name: 'gwosè', value: '5 mamit' }],
  locations: [
    { locationName: 'Main Store', isDefault: true, quantity: 5 },
    { locationName: 'Backroom', isDefault: false, quantity: 12 },
  ],
});

describe('current stock translations', () => {
  it('defines every new string in Haitian Creole and in French', () => {
    for (const key of KEYS_ADDED_BY_CURRENT_STOCK) {
      expect(ht[key]?.trim(), `ht.${key}`).toBeTruthy();
      expect(fr[key]?.trim(), `fr.${key}`).toBeTruthy();
    }
  });

  it('says something different in each language, rather than one copied to both', () => {
    const shared = KEYS_ADDED_BY_CURRENT_STOCK.filter((key) => ht[key] === fr[key]);
    expect(shared).toEqual([]);
  });

  it('reuses the words that already existed instead of translating them twice', () => {
    for (const key of KEYS_REUSED_BY_CURRENT_STOCK) {
      expect(ht[key]?.trim(), `ht.${key}`).toBeTruthy();
      expect(fr[key]?.trim(), `fr.${key}`).toBeTruthy();
    }
    // Two spellings of "default location" would eventually become two
    // different words for the same shelf.
    const defaults = Object.keys(ht).filter((key) => key.toLowerCase().includes('defaultlocation'));
    expect(defaults).toEqual(['inventory.defaultLocation']);
  });

  it('names no capability and no ledger word to a user', () => {
    for (const key of KEYS_ADDED_BY_CURRENT_STOCK) {
      for (const value of [ht[key], fr[key]]) {
        expect(value).not.toMatch(/inventory\.|catalog\.|RECEIPT|movement|ledger|projection|hash/i);
      }
    }
  });

  it('reads the screen from the catalogue', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    expect(screen.getByRole('heading', { name: ht['stock.title'] })).toBeInTheDocument();
    expect(screen.getByText(ht['stock.description'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['stock.searchLabel'])).toBeInTheDocument();
    expect(refreshButton()).toHaveTextContent(ht['stock.refresh']);

    await screen.findByText('Diri');
    expect(screen.getByText(ht['stock.total'], { exact: false })).toBeInTheDocument();
    expect(screen.getByText(ht['inventory.defaultLocation'])).toBeInTheDocument();
  });

  it('reads an empty shop from the catalogue', async () => {
    await openStock({ [BALANCES_ROUTE]: json([]) });
    expect(await screen.findByText(ht['stock.noVariants'])).toBeInTheDocument();
  });

  it('reads a shop with no shelves from the catalogue', async () => {
    await openStock({ [BALANCES_ROUTE]: json([balanceFixture({ locations: [] })]) });
    expect(await screen.findByText(ht['stock.noLocations'])).toBeInTheDocument();
  });

  it('reads a search that matched nothing from the catalogue', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });
    await screen.findByText('Diri');

    typeSearch('pen');
    expect(screen.getByText(ht['stock.noMatches'])).toBeInTheDocument();
  });

  it('leaves the shop’s own words untranslated', async () => {
    // Product names, attribute names, SKUs, and location names were typed by
    // the business. They are shown as they were entered, in either language.
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });
    await screen.findByText('Diri');

    expect(screen.getByText('gwosè: 5 mamit')).toBeInTheDocument();
    expect(screen.getByText('EKN-AB12CD34')).toBeInTheDocument();
    expect(screen.getByText('Main Store', { exact: false })).toBeInTheDocument();
  });

  it('leaves no interpolation unfilled', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });
    await screen.findByText('Diri');
    expect(document.body.textContent ?? '').not.toMatch(/\{\w+\}/);
  });

  it('says the same things in French', () => {
    for (const key of [...KEYS_ADDED_BY_CURRENT_STOCK, ...KEYS_REUSED_BY_CURRENT_STOCK]) {
      expect(translate('fr', key), key).toBe(fr[key]);
    }
    // A spot check that the French is French, and not the Creole copied over.
    expect(fr['stock.title']).toContain('Stock');
    expect(fr['stock.refresh']).toBe('Actualiser');
  });

  it('counts in the plural the way each language does', () => {
    // French inflects the noun and Creole does not. "1 résultats" is the kind
    // of small wrongness that makes software feel untrusted, and "1 rezilta /
    // 2 rezilta" is not a mistake — it is Creole.
    expect(fr['stock.resultsOne']).not.toBe(fr['stock.results']);
    expect(ht['stock.resultsOne']).toBe(ht['stock.results']);
    for (const key of ['stock.resultsOne', 'stock.results'] as const) {
      expect(ht[key]).toContain('{count}');
      expect(fr[key]).toContain('{count}');
    }
  });

  it('shows the whole of a long name rather than a shortened one', async () => {
    // Column widths are proportions, not pixel budgets sized to short Creole
    // examples. A shelf the shop named in full is read in full — the browser
    // wraps it, and nothing here cuts it off with an ellipsis of its own.
    const longNames = balanceFixture({
      productName: 'Diri blan gwo grenn ki soti nan Latibonit',
      sku: 'EKN-AB12CD34',
      attributes: [
        { name: 'gwosè', value: '5 mamit' },
        { name: 'mak', value: 'Tchako' },
        { name: 'kalite', value: 'premye chwa' },
      ],
      locations: [
        { locationName: 'Depo prensipal la nan lakou dèyè a', isDefault: true, quantity: 1234 },
      ],
    });
    await openStock({ [BALANCES_ROUTE]: json([longNames]) });

    expect(screen.getByText('Diri blan gwo grenn ki soti nan Latibonit')).toBeInTheDocument();
    expect(
      screen.getByText('gwosè: 5 mamit, mak: Tchako, kalite: premye chwa'),
    ).toBeInTheDocument();
    expect(screen.getByText('Depo prensipal la nan lakou dèyè a')).toBeInTheDocument();
    // A large quantity is the digits the server sent, with no separator, no
    // suffix, and no sign bolted on.
    expect(screen.getByRole('definition')).toHaveTextContent('1234');
  });
});
