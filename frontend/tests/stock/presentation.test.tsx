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
  typeSearch,
} from '../helpers/stock.js';

/**
 * How the stock register reads at each width.
 *
 * The thing being protected is that all three are the *same register*. A laptop
 * gets five columns, a tablet folds the three identity columns into one so the
 * quantities keep their width, and a phone stacks the whole thing — but none of
 * them may lose a fact, invent one, or show a different set of items than the
 * other two. Exactly one is ever in the document, because a hidden column is
 * still a column a screen reader announces.
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

const SHELF = [RICE, OIL];

function columnNames(): string[] {
  return screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
}

describe('the stock register on a laptop', () => {
  it('is a real table with the five reading columns, in order', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) });

    expect(screen.getByRole('table')).toBeInTheDocument();
    // Five columns of facts, then a last one for the ways onward. Its heading
    // is for a screen reader rather than for the design — a visible "Actions"
    // over two small buttons would be a heading over a heading.
    expect(columnNames()).toEqual([
      ht['catalog.columnProduct'],
      ht['catalog.columnVariant'],
      ht['catalog.sku'],
      ht['stock.columnLocations'],
      ht['stock.total'],
      ht['stock.columnActions'],
    ]);
  });

  it('puts the product, the variant, the SKU, the shelves, and the total in one row', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) });

    const rice = stockRecord('Diri');
    expect(within(rice).getByText('gwosè: 5 mamit, mak: Tchako')).toBeInTheDocument();
    expect(within(rice).getByText('EKN-AB12CD34')).toBeInTheDocument();
    expect(locationLines(rice)).toEqual([
      [`Main Store${ht['inventory.defaultLocation']}`, '5'],
      ['Backroom', '12'],
    ]);
    // Five cells beside the row header: variant, SKU, shelves, total, and the
    // ways onward.
    expect(within(rice).getAllByRole('cell')).toHaveLength(5);
  });

  it('names the row by its product, so a quantity is announced with its item', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) });

    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual([
      'Diri',
      'Lwil',
    ]);
  });

  it('offers no column the balance projection has no field for', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) });

    // A value, a cost, a low-stock state, a reorder point, or a last movement
    // would each have to appear here first — and none of them is in the
    // response. Five columns of facts, plus the actions.
    expect(screen.getAllByRole('columnheader')).toHaveLength(6);
    // No selection column, and the row itself is still not a command: nothing
    // here edits a number, and the buttons in the last column are doors to
    // other workflows rather than controls over this one.
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(within(screen.getByRole('row', { name: /Diri/ })).queryAllByRole('button')).toEqual([
      // `inventory.read` alone: history and nothing else.
      expect.objectContaining({ textContent: ht['stock.actionHistory'] }),
    ]);
  });
});

describe('the stock register on a tablet', () => {
  it('stays a table, with the item identity folded into one column', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'tablet' });

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(columnNames()).toEqual([
      ht['stock.columnItem'],
      ht['stock.columnLocations'],
      ht['stock.total'],
      ht['stock.columnActions'],
    ]);
  });

  it('keeps the product, the variant, and the SKU together in the item column', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'tablet' });

    const item = within(stockRecord('Diri')).getAllByRole('rowheader')[0];
    expect(item?.textContent).toContain('Diri');
    expect(item?.textContent).toContain('gwosè: 5 mamit, mak: Tchako');
    expect(item?.textContent).toContain('EKN-AB12CD34');
  });

  it('keeps the shelves and the total as their own columns', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'tablet' });

    const rice = stockRecord('Diri');
    expect(locationLines(rice)).toEqual([
      [`Main Store${ht['inventory.defaultLocation']}`, '5'],
      ['Backroom', '12'],
    ]);
    // Three cells beside the item header: the shelves, the total the server
    // sent for the whole variant, and the ways onward.
    const cells = within(rice).getAllByRole('cell');
    expect(cells).toHaveLength(3);
    expect(cells[1]).toHaveTextContent('17');
  });
});

describe('the stock register on a phone', () => {
  it('reflows into records rather than a table that scrolls sideways', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'mobile' });

    expect(screen.queryByRole('table')).toBeNull();
    expect(stockHeadings()).toEqual(['Diri', 'Lwil']);
  });

  it('carries every fact the table carries', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'mobile' });

    const rice = stockRecord('Diri');
    expect(within(rice).getByText('gwosè: 5 mamit, mak: Tchako')).toBeInTheDocument();
    expect(within(rice).getByText('EKN-AB12CD34')).toBeInTheDocument();
    expect(locationLines(rice)).toEqual([
      [`Main Store${ht['inventory.defaultLocation']}`, '5'],
      ['Backroom', '12'],
    ]);
  });

  it('says the total in words as well as in size', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'mobile' });

    // A large number on the right of a line means nothing to somebody
    // listening to the page.
    const rice = stockRecord('Diri');
    expect(within(rice).getByText(ht['stock.total'])).toBeInTheDocument();
    expect(within(rice).getByText('17')).toBeInTheDocument();
  });
});

describe('one presentation at a time', () => {
  it('mounts the phone records without the table beside them', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'mobile' });

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryAllByRole('columnheader')).toEqual([]);
    // One "Diri" in the document, not one per presentation.
    expect(screen.getAllByText('Diri')).toHaveLength(1);
    expect(screen.getAllByText('EKN-AB12CD34')).toHaveLength(1);
  });

  it('mounts one table at a tablet width, not the desktop one as well', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'tablet' });

    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getAllByText('EKN-AB12CD34')).toHaveLength(1);
    // The desktop columns are absent, not hidden.
    expect(screen.queryByRole('columnheader', { name: ht['catalog.sku'] })).toBeNull();
  });

  it('mounts one table on a laptop, with no phone record behind it', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) });

    expect(screen.getAllByRole('table')).toHaveLength(1);
    // The phone record list is not mounted behind it: no record heading exists.
    expect(screen.queryAllByRole('heading', { level: 2 })).toEqual([]);
    expect(screen.getAllByText('EKN-AB12CD34')).toHaveLength(1);
  });
});

/**
 * Where the total comes from.
 *
 * The response carries both the per-location quantities and a `totalQuantity`,
 * and the backend is the thing that reconciles them. A screen that quietly
 * re-added the locations would look right every day the two agree and would
 * disagree with the server on the day they do not — and a shop would then have
 * two answers to "how much rice is there".
 */
describe('the total quantity', () => {
  const DISAGREEING = balanceFixture({
    productName: 'Diri',
    sku: 'EKN-AB12CD34',
    locations: [
      { locationName: 'Main Store', isDefault: true, quantity: 5 },
      { locationName: 'Backroom', isDefault: false, quantity: 12 },
    ],
    // Not 17. The schema validates each number, not the arithmetic between
    // them, so this is a response the contract permits — and the only fixture
    // that can tell "shows the total" apart from "adds the shelves up".
    totalQuantity: 99,
  });

  it('is the number the server sent, not the shelves added up', async () => {
    await openStock({ [BALANCES_ROUTE]: json([DISAGREEING]) });

    const cells = within(stockRecord('Diri')).getAllByRole('cell');
    // The total is the second-to-last cell now that the actions follow it.
    expect(cells[cells.length - 2]).toHaveTextContent('99');
    // And the shelf quantities are still the shelf quantities.
    expect(locationLines(stockRecord('Diri')).map(([, quantity]) => quantity)).toEqual(['5', '12']);
    expect(screen.queryByText('17')).toBeNull();
  });

  it('is the same number on a phone', async () => {
    await openStock({ [BALANCES_ROUTE]: json([DISAGREEING]) }, { viewport: 'mobile' });

    expect(within(stockRecord('Diri')).getByText('99')).toBeInTheDocument();
    expect(screen.queryByText('17')).toBeNull();
  });
});

/**
 * The count beside the search field. It counts what is on screen and nothing
 * else — not a business figure, and never a number the response did not
 * produce.
 */
describe('the result count', () => {
  it('counts the whole list before anybody types', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) });
    expect(screen.getByText(ht['stock.results'].replace('{count}', '2'))).toBeInTheDocument();
  });

  it('counts what the search left, in the singular when there is one of it', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) });

    typeSearch('diri');
    expect(stockHeadings()).toEqual(['Diri']);
    expect(screen.getByText(ht['stock.resultsOne'].replace('{count}', '1'))).toBeInTheDocument();
  });

  it('says none rather than disappearing when nothing matched', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) });

    typeSearch('pen');
    expect(screen.getByText(ht['stock.results'].replace('{count}', '0'))).toBeInTheDocument();
  });

  it('counts the same records on a phone', async () => {
    await openStock({ [BALANCES_ROUTE]: json(SHELF) }, { viewport: 'mobile' });

    typeSearch('diri');
    expect(stockHeadings()).toEqual(['Diri']);
    expect(screen.getByText(ht['stock.resultsOne'].replace('{count}', '1'))).toBeInTheDocument();
  });
});
