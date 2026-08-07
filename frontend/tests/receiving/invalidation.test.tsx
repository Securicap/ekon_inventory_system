import { fireEvent, screen } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { inventoryBalancesQueryKey } from '../../src/lib/inventoryQueries.js';
import {
  apiFailure,
  json,
  mockApi,
  offline,
  type FetchMock,
  type Responder,
} from '../helpers/fetchMock.js';
import {
  balanceFixture,
  locationFixture,
  productFixture,
  userFixture,
  userResponse,
  variantIdOf,
} from '../helpers/fixtures.js';
import { renderApp, settle } from '../helpers/renderApp.js';
import {
  fillReceivingForm,
  receiptResponse,
  submitReceivingForm,
  RECEIVE_ROUTE,
} from '../helpers/receiving.js';
import { BALANCES_ROUTE } from '../helpers/stock.js';

/**
 * Booking in a delivery, then walking back to the stock screen.
 *
 * This is the first read model in the application that a write makes stale.
 * Until now receiving changed nothing anybody was looking at — it creates no
 * product and opens no counter — so it invalidated nothing. Now there is a
 * screen whose whole job is to say how much there is, and an employee who
 * books in twelve sacks and then reads the old number has been lied to by
 * their own application.
 *
 * What must hold, and what these tests are about:
 *
 *  - a confirmed `201` invalidates the stock read, so the next look at it asks
 *    the server again;
 *  - a refusal or a dropped connection invalidates nothing, because nothing
 *    moved — and marking stock stale on a failure would spend a request to
 *    re-learn the number we already have;
 *  - a replay of an earlier receipt is a success like any other;
 *  - none of it can turn a confirmed receipt into an ambiguous one.
 */

const RICE = productFixture({ name: 'Diri', sku: 'EKN-AB12CD34' });

function stockOf(quantity: number) {
  return balanceFixture({
    productName: 'Diri',
    sku: 'EKN-AB12CD34',
    locations: [{ locationName: 'Main Store', isDefault: true, quantity }],
  });
}

const CAPABILITIES: readonly Capability[] = ['catalog.read', 'inventory.read', 'inventory.receive'];

/**
 * Signs in somebody who can do both, reads the stock screen so the balance
 * query is really in the cache, and then opens receiving — which is the order
 * an employee does it in: look at the shelf, then book in what arrived.
 */
async function openStockThenReceiving(
  routes: Record<string, Responder | Responder[]>,
): Promise<{ api: FetchMock; queryClient: QueryClient }> {
  const api = mockApi({
    'GET /api/auth/me': json(userResponse(userFixture({ capabilities: CAPABILITIES }))),
    'GET /api/catalog/products': json([RICE]),
    'GET /api/inventory/locations': json([locationFixture()]),
    [BALANCES_ROUTE]: json([stockOf(5)]),
    ...routes,
  });

  const { queryClient } = renderApp();
  await screen.findByText('Marie Joseph');

  fireEvent.click(screen.getByRole('button', { name: ht['nav.stock'] }));
  await screen.findByText('Diri');

  fireEvent.click(screen.getByRole('button', { name: ht['nav.receive'] }));
  await screen.findByRole('heading', { name: ht['receiving.title'] });
  await settle();

  return { api, queryClient };
}

function receiveTwelveSacks(): void {
  fillReceivingForm({
    variantId: variantIdOf(RICE),
    quantity: '12',
    occurredAtLocal: '2026-08-04T14:30',
  });
  submitReceivingForm();
}

function backToStock(): void {
  fireEvent.click(screen.getByRole('button', { name: ht['nav.stock'] }));
}

describe('a confirmed receipt', () => {
  it('marks the current stock as no longer current', async () => {
    const { queryClient } = await openStockThenReceiving({
      [RECEIVE_ROUTE]: json(receiptResponse({ quantityAfter: 17 }), 201),
    });

    expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(false);

    receiveTwelveSacks();
    await screen.findByRole('status');

    expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(true);
  });

  it('shows the new quantity the next time somebody looks at the shelf', async () => {
    // The behaviour that matters, stated the way an employee experiences it:
    // book in twelve, go back to stock, and read a number that has moved.
    // Without the invalidation the query is still inside its 30-second stale
    // window and would render 5 from the cache.
    const { api } = await openStockThenReceiving({
      [BALANCES_ROUTE]: [json([stockOf(5)]), json([stockOf(17)])],
      [RECEIVE_ROUTE]: json(receiptResponse({ quantityAfter: 17 }), 201),
    });

    receiveTwelveSacks();
    await screen.findByRole('status');

    backToStock();

    expect(await screen.findByText('17', { selector: 'dd' })).toBeInTheDocument();
    expect(api.to(BALANCES_ROUTE)).toHaveLength(2);
  });

  it('invalidates nothing else', async () => {
    // Receiving created no product and opened no counter. Re-reading either
    // would be spending a request on a connection that drops to learn nothing.
    const { api, queryClient } = await openStockThenReceiving({
      [RECEIVE_ROUTE]: json(receiptResponse(), 201),
    });

    receiveTwelveSacks();
    await screen.findByRole('status');
    await settle();

    expect(queryClient.getQueryState(['catalog', 'products'])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(['inventory', 'locations'])?.isInvalidated).toBe(false);
    expect(api.to('GET /api/catalog/products')).toHaveLength(1);
    expect(api.to('GET /api/inventory/locations')).toHaveLength(1);
  });

  it('treats a replay of an earlier receipt as the success it is', async () => {
    // The server answers a repeated operation id with the movement it already
    // posted, and answers it `201`. The stock is right either way, so the extra
    // read costs one request and keeps the two paths identical.
    const { api, queryClient } = await openStockThenReceiving({
      [RECEIVE_ROUTE]: [offline(), json(receiptResponse({ quantityAfter: 17 }), 201)],
      [BALANCES_ROUTE]: [json([stockOf(5)]), json([stockOf(17)])],
    });

    receiveTwelveSacks();
    await screen.findByRole('alert');
    expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(false);

    // The same command, under the same operation id.
    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retrySame'] }));
    await screen.findByRole('status');

    expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(true);
    const [first, second] = api.to(RECEIVE_ROUTE).map((request) => request.body);
    expect(second).toEqual(first);

    backToStock();
    expect(await screen.findByText('17', { selector: 'dd' })).toBeInTheDocument();
  });

  it('stays a confirmed receipt whatever the cache does afterwards', async () => {
    // The movement is permanent the moment the server answers 201. A refetch
    // that fails afterwards is the stock screen's problem to render, and must
    // never turn a booked delivery into "did that work?".
    await openStockThenReceiving({
      [BALANCES_ROUTE]: [json([stockOf(5)]), apiFailure('INTERNAL', 500)],
      [RECEIVE_ROUTE]: json(receiptResponse({ quantityAfter: 17 }), 201),
    });

    receiveTwelveSacks();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('17');
    await settle();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByRole('button', { name: ht['receiving.receiveAnother'] }),
    ).toBeInTheDocument();
  });
});

describe('a receipt that did not go through', () => {
  it('invalidates nothing when the server refuses it', async () => {
    const { api, queryClient } = await openStockThenReceiving({
      [RECEIVE_ROUTE]: apiFailure('CONFLICT', 409),
    });

    receiveTwelveSacks();
    await screen.findByRole('alert');
    await settle();

    expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(false);
    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
  });

  it('invalidates nothing when the connection drops', async () => {
    // Nothing is known to have moved, and nothing may be assumed to have. The
    // remedy is the retry button, not a cache eviction.
    const { api, queryClient } = await openStockThenReceiving({
      [RECEIVE_ROUTE]: offline(),
    });

    receiveTwelveSacks();
    await screen.findByRole('alert');
    await settle();

    expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(false);
    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
  });

  it('still shows the old number when somebody goes back to the shelf', async () => {
    await openStockThenReceiving({ [RECEIVE_ROUTE]: apiFailure('FORBIDDEN', 403) });

    receiveTwelveSacks();
    await screen.findByRole('alert');

    backToStock();
    expect(await screen.findByText('5', { selector: 'dd' })).toBeInTheDocument();
  });
});
