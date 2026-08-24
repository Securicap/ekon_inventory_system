import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { json, mockApi } from '../helpers/fetchMock.js';
import { productFixture, userFixture, userResponse } from '../helpers/fixtures.js';
import { CATALOG_ROUTE, CATALOG_WRITER, openCatalog } from '../helpers/catalog.js';
import { renderApp, settle } from '../helpers/renderApp.js';
import { viewport } from '../helpers/viewport.js';

/**
 * Products, as merchandise.
 *
 * The thing being protected here is the distinction a person was confused by:
 * **Products is not Inventory**. This screen carries brand, name,
 * classification, the variants underneath and what each one is worth — and it
 * carries no quantity, no location and no total, because a product exists
 * whether or not any is on a shelf.
 *
 * The old register-style table is gone with it. A flat three-column table
 * repeated the brand and the classification on every row and still did not
 * group them; a card per product with its variants under it is the shape the
 * merchandise model actually has.
 */

const BEL_AMI = productFixture({
  name: 'Bel Ami',
  sku: 'EKN-AB12CD34',
  brand: { id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01', name: 'Steve Madden' },
  classifications: [
    { dimension: 'audience', dimensionName: 'Audience', value: 'Fanm' },
    { dimension: 'category', dimensionName: 'Category', value: 'Soulye' },
  ],
  attributes: [
    { name: 'color', value: 'Nwa' },
    { name: 'size', value: '38' },
  ],
  sellingPrice: { amountMinor: 750000, currency: 'HTG' },
  referenceCost: { amountMinor: 40000, currency: 'USD' },
  barcodes: ['0123456789012'],
});

/** Merchandise nobody has completed: no brand, nothing classified, no price. */
const PLAIN = productFixture({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a04',
  name: 'Lwil',
  sku: 'EKN-Z9Y8X7W6',
});

function card(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).closest('article') as HTMLElement;
}

describe('merchandise identity', () => {
  it('reads brand, then product, then how it is classified', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json([BEL_AMI]) });

    const product = card('Bel Ami');
    expect(within(product).getByText('Steve Madden')).toBeInTheDocument();
    // The classification as one line in the catalog's own order, not three
    // labelled fields — it identifies merchandise, it is not a form.
    expect(within(product).getByText('Fanm · Soulye')).toBeInTheDocument();
  });

  it('shows each variant with its attributes, its SKU, and what it is worth', async () => {
    await openCatalog({ [CATALOG_ROUTE]: json([BEL_AMI]) });

    const product = card('Bel Ami');
    expect(within(product).getByText('color: Nwa, size: 38')).toBeInTheDocument();
    expect(within(product).getByText('EKN-AB12CD34')).toBeInTheDocument();
    // Minor units, formatted with the currency code — never a bare number, and
    // never a symbol: this shop buys in one currency and sells in another.
    // `Intl` separates the thousands and the currency code with no-break
    // spaces; the query's own normalization is what makes these read as typed.
    expect(within(product).getByText('7 500,00 HTG')).toBeInTheDocument();
    // Cost carries its label into the sentence — a second figure beside a price
    // is read as profit if nothing says what it is (INV-17).
    expect(within(product).getByText(`${ht['catalog.cost']} 400,00 USD`)).toBeInTheDocument();
    expect(within(product).getByText('0123456789012')).toBeInTheDocument();
  });

  it('says a price is absent rather than showing a zero', async () => {
    // `null` means nobody has established one. A zero would mean the item is
    // free, and somebody would eventually compute a margin from it.
    await openCatalog({ [CATALOG_ROUTE]: json([PLAIN]) });

    expect(within(card('Lwil')).getByText(ht['catalog.noPrice'])).toBeInTheDocument();
    expect(within(card('Lwil')).queryByText('0,00')).toBeNull();
  });

  it('groups a product with several variants under one name', async () => {
    const twoSizes = {
      ...BEL_AMI,
      variants: [
        ...BEL_AMI.variants,
        {
          ...BEL_AMI.variants[0]!,
          id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4aff',
          sku: 'EKN-QR90ST12',
          attributes: [
            { name: 'color', value: 'Nwa' },
            { name: 'size', value: '39' },
          ],
        },
      ],
    };
    await openCatalog({ [CATALOG_ROUTE]: json([twoSizes]) });

    // One heading, two SKUs under it: the product is named once.
    expect(screen.getAllByRole('heading', { name: 'Bel Ami' })).toHaveLength(1);
    const product = card('Bel Ami');
    expect(within(product).getByText('EKN-AB12CD34')).toBeInTheDocument();
    expect(within(product).getByText('EKN-QR90ST12')).toBeInTheDocument();
  });

  it('carries no quantity, no location and no total anywhere', async () => {
    // The whole distinction from Inventory, asserted rather than described. A
    // stock figure on this screen would put the two back together.
    await openCatalog({ [CATALOG_ROUTE]: json([BEL_AMI, PLAIN]) });

    expect(screen.queryByText(ht['stock.total'])).toBeNull();
    expect(screen.queryByText(ht['stock.columnLocations'])).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('lifecycle on the merchandise', () => {
  it('marks merchandise that is no longer restocked, and leaves active alone', async () => {
    // Active wears no chip: a column of "Active" is a column nobody reads, and
    // it makes the two states worth noticing harder to see.
    await openCatalog({
      [CATALOG_ROUTE]: json([{ ...PLAIN, lifecycleStatus: 'DISCONTINUED' }, BEL_AMI]),
    });

    expect(within(card('Lwil')).getByText(ht['catalog.lifecycleDiscontinued'])).toBeInTheDocument();
    expect(within(card('Bel Ami')).queryByText(ht['catalog.lifecycleActive'])).toBeNull();
  });

  it('marks an archived variant under a product that is still active', async () => {
    await openCatalog({
      [CATALOG_ROUTE]: json([
        {
          ...PLAIN,
          variants: [{ ...PLAIN.variants[0]!, lifecycleStatus: 'ARCHIVED' }],
        },
      ]),
    });

    expect(within(card('Lwil')).getByText(ht['catalog.lifecycleArchived'])).toBeInTheDocument();
  });

  it('offers no lifecycle control without catalog.deactivate', async () => {
    // Entering merchandise and withdrawing it are different authorities.
    await openCatalog({ [CATALOG_ROUTE]: json([BEL_AMI]) }, { capabilities: CATALOG_WRITER });

    expect(screen.queryByLabelText(/Bel Ami/)).toBeNull();
    expect(screen.queryByText(ht['catalog.lifecycleChange'])).toBeNull();
  });

  it('offers it to somebody who holds catalog.deactivate', async () => {
    await openCatalog(
      { [CATALOG_ROUTE]: json([BEL_AMI]) },
      { capabilities: ['catalog.read', 'catalog.deactivate'] },
    );

    const control = within(card('Bel Ami')).getByRole('combobox');
    expect([...(control as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(
      [
        ht['catalog.lifecycleChange'],
        // Forward through the lifecycle, from ACTIVE.
        ht['catalog.lifecycleMakeDiscontinued'],
        ht['catalog.lifecycleMakeArchived'],
      ],
    );
  });

  it('offers archived merchandise one step back, and not straight to active', async () => {
    // The server refuses `ARCHIVED → ACTIVE`: coming back into use and being
    // restocked again are two decisions, so they are two steps.
    await openCatalog(
      { [CATALOG_ROUTE]: json([{ ...BEL_AMI, lifecycleStatus: 'ARCHIVED' }]) },
      { capabilities: ['catalog.read', 'catalog.deactivate'] },
    );

    const control = within(card('Bel Ami')).getByRole('combobox');
    expect([...(control as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(
      [ht['catalog.lifecycleChange'], ht['catalog.lifecycleMakeDiscontinued']],
    );
  });
});

describe('on a phone', () => {
  it('reads the same merchandise, reached through the More sheet', async () => {
    // Products is not one of the everyday destinations the bottom bar carries,
    // and the sheet behind More is the complete list of what somebody may open.
    viewport('mobile');
    mockApi({
      'GET /api/auth/me': json(userResponse(userFixture({ capabilities: CATALOG_WRITER }))),
      [CATALOG_ROUTE]: json([BEL_AMI]),
    });
    renderApp();
    await screen.findByRole('button', { name: ht['nav.more'] });
    fireEvent.click(screen.getByRole('button', { name: ht['nav.more'] }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: ht['nav.products'] }),
    );
    await screen.findByRole('heading', { name: ht['catalog.title'] });
    await settle();

    const product = card('Bel Ami');
    expect(within(product).getByText('Steve Madden')).toBeInTheDocument();
    expect(within(product).getByText('EKN-AB12CD34')).toBeInTheDocument();
  });
});
