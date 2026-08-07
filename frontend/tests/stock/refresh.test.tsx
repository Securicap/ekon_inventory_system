import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { deferred, json } from '../helpers/fetchMock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import { settle } from '../helpers/renderApp.js';
import {
  BALANCES_ROUTE,
  openStock,
  refreshButton,
  searchInput,
  stockHeadings,
  typeSearch,
} from '../helpers/stock.js';

/**
 * Asking again, on purpose.
 *
 * Somebody else at the counter books in a delivery, or a count is entered on
 * another laptop, and the numbers on this screen are a few minutes old. The
 * remedy is a button, not a timer: there is no polling and no refresh interval,
 * because a shop on an unreliable connection should spend its bandwidth when
 * somebody asks a question.
 */

function riceHolding(quantity: number) {
  return balanceFixture({
    productName: 'Diri',
    sku: 'EKN-AB12CD34',
    locations: [{ locationName: 'Main Store', isDefault: true, quantity }],
  });
}

const OIL = balanceFixture({
  productId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02',
  productName: 'Lwil',
  sku: 'EKN-Z9Y8X7W6',
  locations: [{ locationName: 'Main Store', isDefault: true, quantity: 3 }],
});

describe('refreshing the stock screen', () => {
  it('asks the server again', async () => {
    const { api } = await openStock({ [BALANCES_ROUTE]: json([riceHolding(5)]) });
    await screen.findByText('Diri');

    fireEvent.click(refreshButton());
    await settle();

    expect(api.to(BALANCES_ROUTE)).toHaveLength(2);
  });

  it('replaces the quantities with the ones that came back', async () => {
    await openStock({
      [BALANCES_ROUTE]: [json([riceHolding(5)]), json([riceHolding(23)])],
    });
    await screen.findByText('Diri');
    expect(screen.getByRole('definition')).toHaveTextContent('5');

    fireEvent.click(refreshButton());

    // Addressed as the location's quantity: the total says the same number for
    // a single-location item, and a test that could not tell them apart would
    // pass on a screen that dropped the shelf.
    await screen.findByText('23', { selector: 'dd' });
    expect(screen.getByRole('definition')).toHaveTextContent('23');
    expect(screen.queryByText('5')).toBeNull();
  });

  it('keeps what was typed in the search field', async () => {
    // A refresh that cleared the search would answer a question nobody asked
    // and hide the row somebody was watching.
    await openStock({
      [BALANCES_ROUTE]: [json([riceHolding(5), OIL]), json([riceHolding(23), OIL])],
    });
    await screen.findByText('Diri');

    typeSearch('diri');
    expect(stockHeadings()).toEqual(['Diri']);

    fireEvent.click(refreshButton());
    await screen.findByText('23', { selector: 'dd' });

    expect(searchInput().value).toBe('diri');
    expect(stockHeadings()).toEqual(['Diri']);
  });

  it('refreshes only the stock, not the catalog or the counters', async () => {
    const { api } = await openStock({ [BALANCES_ROUTE]: json([riceHolding(5)]) });
    await screen.findByText('Diri');

    fireEvent.click(refreshButton());
    await settle();

    expect(api.to('GET /api/catalog/products')).toHaveLength(0);
    expect(api.to('GET /api/inventory/locations')).toHaveLength(0);
    expect(api.to('GET /api/auth/me')).toHaveLength(1);
  });

  it('says it is working, and cannot be started twice at once', async () => {
    const slow = deferred();
    await openStock({ [BALANCES_ROUTE]: [json([riceHolding(5)]), slow.responder] });
    await screen.findByText('Diri');

    fireEvent.click(refreshButton());

    const pending = await screen.findByRole('button', { name: ht['stock.refreshing'] });
    expect(pending).toBeDisabled();

    // The numbers stay on screen while the new ones are on their way, rather
    // than being replaced by a loading line somebody has to wait out.
    expect(screen.getByText('Diri')).toBeInTheDocument();
    expect(screen.queryByText(ht['status.loading'])).toBeNull();

    fireEvent.click(pending);
    slow.resolve(json([riceHolding(23)]));

    await screen.findByText('23', { selector: 'dd' });
    expect(screen.getByRole('button', { name: ht['stock.refresh'] })).toBeEnabled();
  });

  it('is disabled while the first read is still in flight', async () => {
    const slow = deferred();
    await openStock({ [BALANCES_ROUTE]: slow.responder });

    expect(screen.getByText(ht['status.loading'])).toBeInTheDocument();
    expect(refreshButton()).toBeDisabled();

    slow.resolve(json([riceHolding(5)]));
    await screen.findByText('Diri');
    expect(refreshButton()).toBeEnabled();
  });

  it('does not reload the application', async () => {
    // Still signed in, still inside the shell, still on the same screen.
    await openStock({ [BALANCES_ROUTE]: json([riceHolding(5)]) });
    await screen.findByText('Diri');

    fireEvent.click(refreshButton());
    await settle();

    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    const navigation = screen.getByRole('navigation');
    expect(within(navigation).getByRole('button', { name: ht['nav.stock'] })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
