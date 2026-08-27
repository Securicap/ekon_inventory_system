import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { json } from '../helpers/fetchMock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import {
  BALANCES_ROUTE,
  locationLines,
  openStock,
  stockHeadings,
  stockRecord,
} from '../helpers/stock.js';
import { settle } from '../helpers/renderApp.js';

/**
 * What an employee sees when they ask what the shop has.
 *
 * The whole question this screen answers is "what do we have, which variant is
 * it, where is it, and how much is there?", so these tests are about a person
 * recognizing an item and reading a number — not about React state, not about
 * the shape of the request, and never about a field the ledger keeps for
 * itself.
 */

const RICE = balanceFixture({
  productName: 'Diri',
  sku: 'EKN-AB12CD34',
  attributes: [
    { name: 'gwosè', value: '5 mamit' },
    { name: 'mak', value: 'Tchako' },
  ],
  locations: [
    { locationName: 'Main Store', isDefault: true, quantity: 5 },
    { locationName: 'Backroom', isDefault: false, quantity: 12 },
  ],
});

const OIL = balanceFixture({
  productId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02',
  productName: 'Lwil',
  sku: 'EKN-Z9Y8X7W6',
  locations: [{ locationName: 'Main Store', isDefault: true, quantity: 3 }],
});

describe('the stock screen', () => {
  it('reads the balances, and nothing else', async () => {
    const { api } = await openStock({ [BALANCES_ROUTE]: json([RICE]) });
    await screen.findByText('Diri');
    await settle();

    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
    // The response already carries the product name, the SKU, the attributes,
    // and every location's name. A screen that also read the catalog and the
    // location list would be assembling the same picture out of pieces that can
    // disagree — and would be two more requests on a bad connection.
    expect(api.to('GET /api/catalog/products')).toHaveLength(0);
    expect(api.to('GET /api/inventory/locations')).toHaveLength(0);
  });

  it('carries the session the way every other read does', async () => {
    const { api } = await openStock({ [BALANCES_ROUTE]: json([RICE]) });
    await screen.findByText('Diri');

    const [request] = api.to(BALANCES_ROUTE);
    expect(request?.credentials).toBe('same-origin');
    expect(request?.method).toBe('GET');
    // Same origin, so a path and not an absolute URL, and no Authorization
    // header — the session cookie is http-only and the browser carries it.
    expect(request?.url).toBe('/api/inventory/balances');
    expect(Object.keys(request?.headers ?? {})).not.toContain('authorization');
  });

  it('names the item the way somebody holding the box would recognize it', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    const rice = stockRecord('Diri');
    expect(within(rice).getByText('gwosè: 5 mamit, mak: Tchako')).toBeInTheDocument();
    expect(within(rice).getByText('EKN-AB12CD34')).toBeInTheDocument();
  });

  it('says a variant has no attributes rather than leaving the cell blank', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE, OIL]) });

    // The same words the catalog uses for the same fact. Two spellings of "this
    // one is sold one way" would read as two different facts.
    const oil = stockRecord('Lwil');
    expect(within(oil).getByText(ht['catalog.noAttributes'])).toBeInTheDocument();
    expect(within(oil).getByText('EKN-Z9Y8X7W6')).toBeInTheDocument();
  });

  it('shows the total the server sent, in its own column', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    expect(screen.getByRole('columnheader', { name: ht['stock.total'] })).toBeInTheDocument();
    // 5 + 12, as the backend summed it.
    expect(totalOf('Diri')).toBe('17');
  });

  it('shows every location, with its own quantity, inside the one record', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    // Two shelves, one item — not two rows that happen to sit together.
    const lines = locationLines(stockRecord('Diri'));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.[0]).toContain('Main Store');
    expect(lines[0]?.[1]).toBe('5');
    expect(lines[1]?.[0]).toContain('Backroom');
    expect(lines[1]?.[1]).toBe('12');
  });

  it('keeps the order the projection returned, with the default shelf first', async () => {
    const reordered = balanceFixture({
      productName: 'Diri',
      locations: [
        { locationName: 'Main Store', isDefault: true, quantity: 1 },
        { locationName: 'Anba eskalye', isDefault: false, quantity: 2 },
        { locationName: 'Backroom', isDefault: false, quantity: 3 },
      ],
    });
    await openStock({ [BALANCES_ROUTE]: json([reordered]) });

    // Not alphabetical: the server puts the default location first and the
    // screen does not re-sort it for the look of the thing.
    expect(locationLines(stockRecord('Diri')).map(([name]) => name.split(' ')[0])).toEqual([
      'Main',
      'Anba',
      'Backroom',
    ]);
  });

  it('marks the default location in words', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    const [main, backroom] = locationLines(stockRecord('Diri'));
    // A word, not a colour: somebody who cannot see the difference reads the
    // same marker everybody else does.
    expect(main?.[0]).toContain(ht['inventory.defaultLocation']);
    expect(backroom?.[0]).not.toContain(ht['inventory.defaultLocation']);
  });

  it('shows a location holding nothing rather than dropping it', async () => {
    // "Main Store: 0, Backroom: 14" and "there is no Main Store" are different
    // facts, and an employee sent to the wrong shelf cannot tell them apart.
    const empty = balanceFixture({
      productName: 'Diri',
      locations: [
        { locationName: 'Main Store', isDefault: true, quantity: 0 },
        { locationName: 'Backroom', isDefault: false, quantity: 14 },
      ],
    });
    await openStock({ [BALANCES_ROUTE]: json([empty]) });

    expect(locationLines(stockRecord('Diri')).map(([, quantity]) => quantity)).toEqual(['0', '14']);
  });

  it('shows a variant nobody has ever stocked, without inventing a date', async () => {
    const neverStocked = balanceFixture({
      productName: 'Sik',
      sku: 'EKN-11223344',
      locations: [
        { locationName: 'Main Store', isDefault: true, quantity: 0, updatedAt: null },
        { locationName: 'Backroom', isDefault: false, quantity: 0, updatedAt: null },
      ],
    });
    await openStock({ [BALANCES_ROUTE]: json([neverStocked]) });

    const sugar = stockRecord('Sik');
    expect(within(sugar).getByText('EKN-11223344')).toBeInTheDocument();
    expect(locationLines(sugar).map(([, quantity]) => quantity)).toEqual(['0', '0']);
    // `updatedAt` is when a projection last moved, not when anybody counted.
    // A screen that filled the gap with today's date would be inventing a
    // moment nothing happened at.
    expect(sugar.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}|2026|null|Invalid/);
  });

  it('shows several items at once', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE, OIL]) });
    expect(stockHeadings()).toEqual(['Diri', 'Lwil']);
  });

  it('repeats the product name for a second variant rather than grouping it away', async () => {
    // The projection is a flat list of variant balances with no product
    // grouping in it, and one row is one of those records. Two sizes of rice
    // are two rows, each with its own SKU, its own shelves, and its own total.
    const large = balanceFixture({
      variantId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4af9',
      productName: 'Diri',
      sku: 'EKN-QR90ST12',
      attributes: [{ name: 'gwosè', value: '25 liv' }],
      locations: [{ locationName: 'Main Store', isDefault: true, quantity: 4 }],
    });
    await openStock({ [BALANCES_ROUTE]: json([RICE, large]) });

    expect(stockHeadings()).toEqual(['Diri', 'Diri']);
    expect(screen.getByText('EKN-AB12CD34')).toBeInTheDocument();
    expect(screen.getByText('EKN-QR90ST12')).toBeInTheDocument();
    // No row span holding the two together: a search that removed one would
    // leave the other's grouping pointing at a row that is no longer there.
    for (const header of screen.getAllByRole('rowheader')) {
      expect(header.getAttribute('rowspan')).toBeNull();
    }
  });

  it('shows no database identifier anywhere on the page', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE, OIL]) });
    const page = document.body.textContent ?? '';

    for (const id of [
      RICE.variantId,
      RICE.productId,
      OIL.variantId,
      OIL.productId,
      ...RICE.locations.map((location) => location.locationId),
    ]) {
      expect(page).not.toContain(id);
    }
    // Nor any of the ledger's own vocabulary.
    expect(page).not.toMatch(/movement|operation|ledger|hash|RECEIPT|signature/i);
  });

  it('offers only the ways onward the capabilities allow', async () => {
    // Reading stock does not imply permission to change it. On
    // `inventory.read` alone the row offers exactly one thing — this item's
    // history, which is a read behind the same capability — and neither Count
    // nor Correct appears at all. Not disabled: absent.
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    const rice = stockRecord('Diri');
    expect(
      within(rice)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([ht['stock.actionHistory']]);
    expect(within(rice).queryByRole('button', { name: ht['stock.actionCount'] })).toBeNull();
    expect(within(rice).queryByRole('button', { name: ht['stock.actionAdjust'] })).toBeNull();
    // And the row itself is still not a control: no link, no checkbox, no
    // editable number, and nothing in it that a click on the row would do.
    expect(within(rice).queryAllByRole('link')).toEqual([]);
    expect(within(rice).queryAllByRole('checkbox')).toEqual([]);
    expect(within(rice).queryAllByRole('textbox')).toEqual([]);
  });

  it('offers counting and correcting to somebody who may do them', async () => {
    await openStock(
      { [BALANCES_ROUTE]: json([RICE]) },
      { capabilities: ['inventory.read', 'inventory.count', 'inventory.adjust'] },
    );

    expect(
      within(stockRecord('Diri'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([ht['stock.actionHistory'], ht['stock.actionCount'], ht['stock.actionAdjust']]);
  });

  it('offers no way into receiving or removal from a screen that only reads', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    const page = screen.getByRole('main');
    for (const label of [ht['nav.receive'], ht['nav.remove'], ht['receiving.submit']]) {
      expect(within(page).queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('waits for the answer rather than flashing an empty shop', async () => {
    // The empty state and "we have not asked yet" are different, and showing
    // the first while the second is true tells somebody the shop stocks
    // nothing.
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });
    expect(screen.queryByText(ht['stock.noVariants'])).toBeNull();

    await screen.findByText('Diri');
    expect(screen.queryByText(ht['status.loading'])).toBeNull();
  });
});

describe('a shop with nothing to show', () => {
  it('says there is no active product to stock, and is not an error', async () => {
    await openStock({ [BALANCES_ROUTE]: json([]) });

    expect(await screen.findByText(ht['stock.noVariants'])).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(stockHeadings()).toEqual([]);
  });

  it('leaves the search field harmless when there is nothing to search', async () => {
    await openStock({ [BALANCES_ROUTE]: json([]) });
    await screen.findByText(ht['stock.noVariants']);

    expect(screen.getByLabelText(ht['stock.searchLabel'])).toBeDisabled();
    // Not the "no results" message: nothing was searched. And no count either,
    // because there is no list for a count to be about.
    expect(screen.queryByText(ht['stock.noMatches'])).toBeNull();
    expect(screen.queryByText(ht['stock.results'].replace('{count}', '0'))).toBeNull();
  });

  it('points nobody at a screen their account may not open', async () => {
    // A person may hold `inventory.read` and neither `inventory.receive` nor
    // `inventory.remove`. An empty shop is not an invitation to book stock in.
    await openStock({ [BALANCES_ROUTE]: json([]) });
    await screen.findByText(ht['stock.noVariants']);

    const page = screen.getByRole('main');
    expect(within(page).queryByRole('button', { name: ht['nav.receive'] })).toBeNull();
  });
});

describe('a business with no active location', () => {
  it('keeps the item visible and says the shelves are missing', async () => {
    const homeless = balanceFixture({ productName: 'Diri', locations: [] });
    expect(homeless.locations).toEqual([]);
    expect(homeless.totalQuantity).toBe(0);

    await openStock({ [BALANCES_ROUTE]: json([homeless]) });

    // The row stays. The product exists; it is the shelves that do not.
    expect(stockHeadings()).toEqual(['Diri']);
    expect(screen.getByText(ht['stock.noLocations'])).toBeInTheDocument();
    // And no shelf is invented to fill the space.
    expect(screen.queryAllByRole('term')).toEqual([]);
    expect(screen.queryByText(ht['inventory.defaultLocation'])).toBeNull();
  });
});

/** The Total cell of one row, addressed as the last cell rather than by its text. */
/**
 * The total, which is the second-to-last cell: the row ends with the ways
 * onward, and those are not a fact about the stock.
 */
function totalOf(productName: string): string {
  const cells = within(stockRecord(productName)).getAllByRole('cell');
  return cells[cells.length - 2]?.textContent ?? '';
}
