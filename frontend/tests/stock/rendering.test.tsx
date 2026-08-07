import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { json } from '../helpers/fetchMock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import { BALANCES_ROUTE, openStock, stockHeadings } from '../helpers/stock.js';
import { settle } from '../helpers/renderApp.js';

/**
 * What an employee sees when they ask what the shop has.
 *
 * The whole question this screen answers is "what do we have, and where is
 * it?", so these tests are about a person recognizing an item and reading a
 * number — not about React state, not about the shape of the request, and never
 * about a field the ledger keeps for itself.
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

/** The card for one product, so a test reads one item rather than the page. */
function card(productName: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: productName, level: 3 });
  const item = heading.closest('li');
  if (!item) throw new Error(`No stock card for ${productName}`);
  return item;
}

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

    const rice = card('Diri');
    expect(within(rice).getByText('gwosè: 5 mamit, mak: Tchako')).toBeInTheDocument();
    expect(within(rice).getByText('EKN-AB12CD34')).toBeInTheDocument();
  });

  it('shows a product with no attributes without an empty line where they would be', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE, OIL]) });

    const oil = card('Lwil');
    expect(within(oil).getByText('EKN-Z9Y8X7W6')).toBeInTheDocument();
    // The SKU and the total, and no third paragraph holding nothing — the rice
    // above has that third one because it has attributes to put in it.
    expect(oil.querySelectorAll('p')).toHaveLength(2);
    expect(card('Diri').querySelectorAll('p')).toHaveLength(3);
  });

  it('shows the total the server sent, labelled as a total', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    const rice = card('Diri');
    expect(within(rice).getByText(ht['stock.total'], { exact: false })).toBeInTheDocument();
    // 5 + 12, as the backend summed it. The screen does not recompute it.
    expect(within(rice).getByText('17')).toBeInTheDocument();
  });

  it('shows every location, with its own quantity', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    const rice = card('Diri');
    const terms = within(rice)
      .getAllByRole('term')
      .map((term) => term.textContent ?? '');
    const quantities = within(rice)
      .getAllByRole('definition')
      .map((definition) => definition.textContent ?? '');

    expect(terms[0]).toContain('Main Store');
    expect(terms[1]).toContain('Backroom');
    expect(quantities).toEqual(['5', '12']);
  });

  it('marks the default location in words', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    const rice = card('Diri');
    const [main, backroom] = within(rice).getAllByRole('term');
    // A word, not a colour: somebody who cannot see the difference reads the
    // same marker everybody else does.
    expect(main?.textContent).toContain(ht['inventory.defaultLocation']);
    expect(backroom?.textContent).not.toContain(ht['inventory.defaultLocation']);
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

    const rice = card('Diri');
    const terms = within(rice).getAllByRole('term');
    const quantities = within(rice)
      .getAllByRole('definition')
      .map((definition) => definition.textContent ?? '');

    expect(terms).toHaveLength(2);
    expect(quantities).toEqual(['0', '14']);
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

    const sugar = card('Sik');
    expect(within(sugar).getByText('EKN-11223344')).toBeInTheDocument();
    expect(
      within(sugar)
        .getAllByRole('definition')
        .map((definition) => definition.textContent),
    ).toEqual(['0', '0']);
    // `updatedAt` is when a projection last moved, not when anybody counted.
    // A screen that filled the gap with today's date would be inventing a
    // moment nothing happened at.
    expect(sugar.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}|2026|null|Invalid/);
  });

  it('shows several items at once', async () => {
    await openStock({ [BALANCES_ROUTE]: json([RICE, OIL]) });
    expect(stockHeadings()).toEqual(['Diri', 'Lwil']);
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

  it('does not turn a row into a control that does nothing', async () => {
    // There is no adjust, no removal, and no history yet. A card that looked
    // clickable would be promising one.
    await openStock({ [BALANCES_ROUTE]: json([RICE]) });

    const rice = card('Diri');
    expect(within(rice).queryAllByRole('button')).toEqual([]);
    expect(within(rice).queryAllByRole('link')).toEqual([]);
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
    expect(stockHeadings()).toEqual([]);
  });

  it('leaves the search field harmless when there is nothing to search', async () => {
    await openStock({ [BALANCES_ROUTE]: json([]) });
    await screen.findByText(ht['stock.noVariants']);

    expect(screen.getByLabelText(ht['stock.searchLabel'])).toBeDisabled();
    // Not the "no results" message: nothing was searched.
    expect(screen.queryByText(ht['stock.noMatches'])).toBeNull();
  });
});

describe('a business with no active location', () => {
  it('keeps the product visible and says the shelves are missing', async () => {
    const homeless = balanceFixture({ productName: 'Diri', locations: [] });
    expect(homeless.locations).toEqual([]);
    expect(homeless.totalQuantity).toBe(0);

    await openStock({ [BALANCES_ROUTE]: json([homeless]) });

    // The row stays. The product exists; it is the shelves that do not.
    const rice = await screen.findByRole('heading', { name: 'Diri', level: 3 });
    expect(rice).toBeInTheDocument();
    expect(screen.getByText(ht['stock.noLocations'])).toBeInTheDocument();
    // And no shelf is invented to fill the space.
    expect(screen.queryAllByRole('term')).toEqual([]);
    expect(screen.queryByText(ht['inventory.defaultLocation'])).toBeNull();
  });
});
