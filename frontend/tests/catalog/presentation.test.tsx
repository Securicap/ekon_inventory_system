import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { json } from '../helpers/fetchMock.js';
import { productFixture } from '../helpers/fixtures.js';
import { CATALOG_ROUTE, CATALOG_WRITER, openCatalog, openNewProduct } from '../helpers/catalog.js';
import { mockApi } from '../helpers/fetchMock.js';
import { userFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp, settle } from '../helpers/renderApp.js';
import { viewport } from '../helpers/viewport.js';

/**
 * The catalog as somebody reaches it on a phone: through the More sheet, since
 * Products is not one of the everyday destinations the bottom bar carries.
 * Deliberately the real route rather than a shortcut past the shell.
 */
async function openCatalogOnPhone(products: unknown[]): Promise<void> {
  viewport('mobile');
  mockApi({
    'GET /api/auth/me': json(userResponse(userFixture({ capabilities: CATALOG_WRITER }))),
    [CATALOG_ROUTE]: json(products),
  });
  renderApp();
  await screen.findByRole('button', { name: ht['nav.more'] });
  fireEvent.click(screen.getByRole('button', { name: ht['nav.more'] }));
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: ht['nav.products'] }),
  );
  await screen.findByRole('heading', { name: ht['catalog.title'] });
  await settle();
}

const COCA = productFixture({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02',
  name: 'Coca-Cola',
  sku: 'EKN-V2WTX95A',
  attributes: [{ name: 'volim', value: '500 ml' }],
});

/** One product carrying two variants, which is the grouping worth proving. */
const RICE = {
  ...productFixture({ name: 'Diri', sku: 'EKN-AB12CD34' }),
  variants: [
    ...productFixture({
      name: 'Diri',
      sku: 'EKN-AB12CD34',
      attributes: [{ name: 'gwosè', value: '5 mamit' }],
    }).variants,
    ...productFixture({
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03',
      name: 'Diri',
      sku: 'EKN-QR90ST12',
      attributes: [{ name: 'gwosè', value: '25 liv' }],
    }).variants,
  ],
};

/** A product sold one way: one variant, no attributes. */
const OIL = productFixture({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a04',
  name: 'Lwil',
  sku: 'EKN-EF56GH78',
});

const SHELF = [COCA, RICE, OIL];

/**
 * How the catalog reads.
 *
 * The thing being protected is the hierarchy: a product is named once and its
 * variants hang under it, so somebody scanning the page can tell that two SKUs
 * belong to one product rather than to two. On a desktop that is a table with a
 * row-group header; on a phone it is a nested list. Both must say the same
 * thing, and neither may invent a column the API has no field for.
 */
describe('the catalog register', () => {
  it('is a real table, with a column for the product, the variant, and the SKU', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json(SHELF) });

    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual([ht['catalog.columnProduct'], ht['catalog.columnVariant'], ht['catalog.sku']]);
  });

  it('names a product once and hangs both of its variants under it', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json(SHELF) });

    // One row-group header per product, not one per variant: this is what says
    // the two rice SKUs are one product.
    const grouped = screen
      .getAllByRole('rowheader')
      .map((header) => [header.textContent, header.getAttribute('rowspan')]);
    expect(grouped).toEqual([
      ['Coca-Cola', '1'],
      ['Diri', '2'],
      ['Lwil', '1'],
    ]);
  });

  it('shows every variant and every generated SKU', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json(SHELF) });

    for (const sku of ['EKN-V2WTX95A', 'EKN-AB12CD34', 'EKN-QR90ST12', 'EKN-EF56GH78']) {
      expect(screen.getByText(sku)).toBeInTheDocument();
    }
    expect(screen.getByText('volim: 500 ml')).toBeInTheDocument();
    expect(screen.getByText('gwosè: 5 mamit')).toBeInTheDocument();
    expect(screen.getByText('gwosè: 25 liv')).toBeInTheDocument();
  });

  it('says a variant has no attributes rather than leaving the cell blank', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json([OIL]) });
    expect(screen.getByText(ht['catalog.noAttributes'])).toBeInTheDocument();
  });

  it('counts what actually arrived, in the singular when there is one of it', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json([OIL]) });

    expect(
      screen.getByText(new RegExp(`^${ht['catalog.countProductsOne'].replace('{count}', '1')}`)),
    ).toBeInTheDocument();
  });

  it('counts them in the plural when there are several', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json(SHELF) });

    const subtitle = screen.getByText(new RegExp(ht['catalog.skuFromServer']));
    // Three products, four variants — read off the response, not from anywhere
    // else, and no other figure appears on the screen.
    expect(subtitle).toHaveTextContent(ht['catalog.countProducts'].replace('{count}', '3'));
    expect(subtitle).toHaveTextContent(ht['catalog.countVariants'].replace('{count}', '4'));
  });

  it('offers no column the catalog has no field for', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json(SHELF) });

    // Three columns, and the row cells to match. A price, a cost, or a stock
    // figure would have to appear here first.
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(within(screen.getAllByRole('row')[1]!).getAllByRole('cell')).toHaveLength(2);
  });
});

describe('the catalog on a phone', () => {
  it('keeps product, variant, and SKU nested rather than scrolling sideways', async () => {
    await openCatalogOnPhone(SHELF);

    // No table at this width — the same facts, carried by nesting.
    expect(screen.queryByRole('table')).toBeNull();

    const rice = screen.getByRole('heading', { name: 'Diri' });
    const record = rice.parentElement!;
    expect(within(record).getByText('gwosè: 5 mamit')).toBeInTheDocument();
    expect(within(record).getByText('EKN-AB12CD34')).toBeInTheDocument();
    expect(within(record).getByText('gwosè: 25 liv')).toBeInTheDocument();
    expect(within(record).getByText('EKN-QR90ST12')).toBeInTheDocument();

    // And a variant of one product never lands inside another's record.
    expect(within(record).queryByText('EKN-V2WTX95A')).toBeNull();
  });

  it('shows every product it was given', async () => {
    await openCatalogOnPhone(SHELF);

    for (const name of ['Coca-Cola', 'Diri', 'Lwil']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });
});

describe('an empty catalog', () => {
  it('points somebody who may create a product at the way to do it', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json([]) });

    expect(screen.getByText(ht['catalog.empty'])).toBeInTheDocument();
    expect(screen.getByText(ht['catalog.emptyHint'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['catalog.newProduct'] })).toBeInTheDocument();
  });

  it('does not send somebody who may not create one to a button they do not have', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json([]) }, { capabilities: ['catalog.read'] });

    expect(screen.getByText(ht['catalog.empty'])).toBeInTheDocument();
    expect(screen.queryByText(ht['catalog.emptyHint'])).toBeNull();
    expect(screen.queryByRole('button', { name: ht['catalog.newProduct'] })).toBeNull();
  });
});

describe('the creation form', () => {
  it('says the SKU comes from the server, and offers no field for it', async () => {
    await openNewProduct();

    const summary = screen.getByRole('complementary', { name: ht['catalog.preview'] });
    expect(within(summary).getByText(ht['catalog.skuServerGenerated'])).toBeInTheDocument();
    // The one identifier nobody on this screen chooses.
    expect(screen.queryByLabelText(ht['catalog.sku'])).toBeNull();
  });

  it('warns that a repeat is a duplicate, because this request carries no operation id', async () => {
    await openNewProduct();

    expect(
      within(screen.getByRole('complementary', { name: ht['catalog.preview'] })).getByText(
        ht['catalog.noOperationId'],
      ),
    ).toBeInTheDocument();
  });

  it('keeps removing a variant reachable by its own name, not just by a cross', async () => {
    await openNewProduct();

    // One variant to start with: nothing to remove yet.
    expect(
      screen.queryByRole('button', { name: ht['catalog.removeVariant'].replace('{number}', '1') }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: ht['catalog.addVariant'] }));

    for (const number of ['1', '2']) {
      expect(
        screen.getByRole('button', {
          name: ht['catalog.removeVariant'].replace('{number}', number),
        }),
      ).toBeInTheDocument();
    }
  });

  it('keeps the attribute remove control named, though it draws as a cross', async () => {
    await openNewProduct();
    fireEvent.click(screen.getByRole('button', { name: ht['catalog.addAttribute'] }));

    expect(screen.getByRole('button', { name: ht['catalog.removeAttribute'] })).toBeInTheDocument();
  });
});
