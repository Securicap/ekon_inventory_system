import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { filterStockBalances, normalizeSearchText } from '../../src/lib/stock.js';
import { json } from '../helpers/fetchMock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import { settle } from '../helpers/renderApp.js';
import {
  BALANCES_ROUTE,
  openStock,
  searchInput,
  stockHeadings,
  typeSearch,
} from '../helpers/stock.js';

/**
 * Finding one item in a list of everything the shop stocks.
 *
 * Entirely in the browser, over a response the server already sent in full.
 * There is no search endpoint and no query parameter — for a single shop the
 * whole active picture is small, and a request per keystroke on a connection
 * that drops would make the field unusable at exactly the counter it is for.
 */

const RICE = balanceFixture({
  productName: 'Diri',
  sku: 'EKN-AB12CD34',
  attributes: [
    { name: 'gwosè', value: '5 mamit' },
    { name: 'mak', value: 'Tchako' },
  ],
  locations: [{ locationName: 'Main Store', isDefault: true, quantity: 5 }],
});

const OIL = balanceFixture({
  productId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02',
  productName: 'Lwil',
  sku: 'EKN-Z9Y8X7W6',
  locations: [{ locationName: 'Backroom', isDefault: false, quantity: 3 }],
});

const SUGAR = balanceFixture({
  productId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03',
  productName: 'Sik',
  sku: 'EKN-11223344',
  attributes: [{ name: 'gwosè', value: '1 liv' }],
  locations: [{ locationName: 'Main Store', isDefault: true, quantity: 0 }],
});

const SHELF = [RICE, OIL, SUGAR];

async function openShelf() {
  return openStock({ [BALANCES_ROUTE]: json(SHELF) });
}

describe('searching the stock list', () => {
  it('shows everything before anybody types', async () => {
    await openShelf();
    expect(stockHeadings()).toEqual(['Diri', 'Lwil', 'Sik']);
  });

  it('finds an item by its name', async () => {
    await openShelf();
    typeSearch('diri');
    expect(stockHeadings()).toEqual(['Diri']);
  });

  it('finds an item by the SKU printed on its shelf label', async () => {
    await openShelf();
    typeSearch('EKN-Z9Y8X7W6');
    expect(stockHeadings()).toEqual(['Lwil']);
  });

  it('finds items by an attribute value', async () => {
    await openShelf();
    typeSearch('5 mamit');
    expect(stockHeadings()).toEqual(['Diri']);
  });

  it('finds items by an attribute name', async () => {
    await openShelf();
    typeSearch('gwosè');
    expect(stockHeadings()).toEqual(['Diri', 'Sik']);
  });

  it('ignores case', async () => {
    await openShelf();
    typeSearch('DIRI');
    expect(stockHeadings()).toEqual(['Diri']);

    typeSearch('ekn-ab12cd34');
    expect(stockHeadings()).toEqual(['Diri']);
  });

  it('ignores whitespace around what was typed', async () => {
    await openShelf();
    typeSearch('   Lwil   ');
    expect(stockHeadings()).toEqual(['Lwil']);
  });

  it('restores everything when the field is cleared', async () => {
    await openShelf();
    typeSearch('diri');
    expect(stockHeadings()).toEqual(['Diri']);

    typeSearch('');
    expect(stockHeadings()).toEqual(['Diri', 'Lwil', 'Sik']);
    expect(screen.queryByText(ht['stock.noMatches'])).toBeNull();
  });

  it('treats a field of spaces as an empty one', async () => {
    await openShelf();
    typeSearch('    ');
    expect(stockHeadings()).toEqual(['Diri', 'Lwil', 'Sik']);
  });

  it('says nothing matched, without calling it an error', async () => {
    await openShelf();
    typeSearch('pen');

    const message = await screen.findByRole('status');
    expect(message).toHaveTextContent(ht['stock.noMatches']);
    expect(stockHeadings()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    // A shop with stock that a search missed is not a shop with no stock.
    expect(screen.queryByText(ht['stock.noVariants'])).toBeNull();
  });

  it('asks the server nothing while somebody types', async () => {
    const { api } = await openShelf();
    typeSearch('d');
    typeSearch('di');
    typeSearch('dir');
    await settle();

    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
    expect(api.requests.filter((request) => request.url.includes('search'))).toEqual([]);
  });

  it('keeps a zero-stock item findable', async () => {
    // Sugar is on the shelf and there is none of it. That is a fact somebody
    // searches for on purpose.
    await openShelf();
    typeSearch('sik');
    expect(stockHeadings()).toEqual(['Sik']);
    expect(screen.getByRole('definition')).toHaveTextContent('0');
  });

  it('offers a real search field with a visible label', async () => {
    await openShelf();
    const field = searchInput();

    expect(field.type).toBe('search');
    expect(field).toBeEnabled();
    expect(screen.getByText(ht['stock.searchLabel'])).toBeInTheDocument();
  });
});

/**
 * The rule on its own, without a screen around it. These are the cases a person
 * changing the filter needs to be able to check in one place.
 */
describe('filterStockBalances', () => {
  it('returns the list unchanged for an empty query', () => {
    expect(filterStockBalances(SHELF, '')).toEqual(SHELF);
    expect(filterStockBalances(SHELF, '   ')).toEqual(SHELF);
  });

  it('keeps the order it was given, rather than ranking by relevance', () => {
    // The server's order is deterministic, and re-sorting as somebody types
    // would move rows under their finger.
    const reversed = [SUGAR, OIL, RICE];
    expect(filterStockBalances(reversed, 'ekn').map((variant) => variant.productName)).toEqual([
      'Sik',
      'Lwil',
      'Diri',
    ]);
  });

  it('matches a substring, not a whole word', () => {
    expect(filterStockBalances(SHELF, 'mami').map((variant) => variant.sku)).toEqual([
      'EKN-AB12CD34',
    ]);
  });

  it('does not match a location name', () => {
    // "Everything in the backroom" is a different question: answering it by
    // substring would return the item while still showing its other locations,
    // which is a filter that lies about what it filtered.
    expect(filterStockBalances(SHELF, 'Backroom')).toEqual([]);
  });

  it('folds accents, so a keyboard without them still finds the word', () => {
    expect(normalizeSearchText('Gwosè')).toBe('gwose');
    expect(filterStockBalances(SHELF, 'gwose').map((variant) => variant.productName)).toEqual([
      'Diri',
      'Sik',
    ]);
  });

  it('finds nothing rather than throwing on an unmatched query', () => {
    expect(filterStockBalances(SHELF, 'zzz')).toEqual([]);
    expect(filterStockBalances([], 'diri')).toEqual([]);
  });
});
