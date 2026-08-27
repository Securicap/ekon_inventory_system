import { fireEvent, screen } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi, type FetchMock, type Responder } from './fetchMock.js';
import { balanceFixture, page, userFixture, userResponse } from './fixtures.js';
import { renderApp, settle } from './renderApp.js';

/**
 * Signs somebody in who may read stock, and opens History the way they would.
 *
 * Like Counts, the destination rides on `inventory.read` — how the numbers got
 * this way is inventory visibility — and the one thing this screen writes to
 * the ledger needs `inventory.reverse`, which is gated on the row rather than
 * at the door.
 */

/** The unfiltered feed, which is what the screen opens on from the sidebar. */
export const MOVEMENTS_ROUTE = 'GET /api/inventory/movements?';
export const REVERSE_ROUTE = 'POST /api/inventory/reverse';
export const BALANCES_ROUTE = 'GET /api/inventory/balances';

/** One filtered read, keyed the way `getMovements` builds its query string. */
export function movementsRoute(query: string): string {
  return `GET /api/inventory/movements?${query}`;
}

/** Somebody who may read the ledger and correct a row in it. */
export const REVERSER: readonly Capability[] = ['inventory.read', 'inventory.reverse'];

export async function openHistory(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[] } = {},
): Promise<{ api: FetchMock; queryClient: QueryClient }> {
  const api = mockApi({
    'GET /api/auth/me': json(
      userResponse(userFixture({ capabilities: options.capabilities ?? ['inventory.read'] })),
    ),
    [MOVEMENTS_ROUTE]: json(page([])),
    // The filters offer merchandise and shelves by name, from the stock read.
    [BALANCES_ROUTE]: json([balanceFixture({ locations: [{ quantity: 7 }] })]),
    'GET /api/inventory/counts?status=OPEN': json(page([])),
    ...routes,
  });

  const { queryClient } = renderApp();
  fireEvent.click(await screen.findByRole('button', { name: ht['nav.history'] }));
  await screen.findByRole('heading', { name: ht['history.title'] });
  await settle();

  return { api, queryClient };
}

/** One movement record, as a person reads it: everything about it in one place. */
export function movementRecord(productName: string): HTMLElement {
  const name = screen.getAllByText(productName)[0];
  const record = name?.closest('li');
  if (!record) throw new Error(`No movement record for ${productName}`);
  return record;
}
