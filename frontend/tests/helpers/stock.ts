import { fireEvent, screen } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi, type FetchMock, type Responder } from './fetchMock.js';
import { balanceFixture, userFixture, userResponse } from './fixtures.js';
import { renderApp, settle } from './renderApp.js';

/**
 * Signs somebody in who may read stock, and opens the stock screen the way they
 * would: by clicking the navigation entry.
 *
 * No shortcut past authentication and no shortcut past the shell — the screen
 * is reached through the same capability check that decides whether it is
 * offered at all.
 */

export const BALANCES_ROUTE = 'GET /api/inventory/balances';

export async function openStock(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[] } = {},
): Promise<{ api: FetchMock; queryClient: QueryClient }> {
  const api = mockApi({
    'GET /api/auth/me': json(
      userResponse(userFixture({ capabilities: options.capabilities ?? ['inventory.read'] })),
    ),
    [BALANCES_ROUTE]: json([balanceFixture()]),
    ...routes,
  });

  const { queryClient } = renderApp();
  await screen.findByText('Marie Joseph');
  fireEvent.click(screen.getByRole('button', { name: ht['nav.stock'] }));
  await screen.findByRole('heading', { name: ht['stock.title'] });
  // The screen renders before its numbers arrive. Every test here is about
  // stock somebody can actually read, so the helper waits for the balance read
  // rather than leaving each test to remember — and a test about a read that
  // has not answered yet still gets the un-answered state, because a tick is
  // all this waits.
  await settle();

  return { api, queryClient };
}

export function searchInput(): HTMLInputElement {
  return screen.getByLabelText(ht['stock.searchLabel']) as HTMLInputElement;
}

/**
 * The refresh control, found by what it is rather than by what it says — its
 * label changes while a fetch is in flight, and a test that pressed it would
 * otherwise stop being able to find it exactly when that matters.
 */
export function refreshButton(): HTMLButtonElement {
  const refresh = screen.queryByRole('button', { name: ht['stock.refresh'] });
  const refreshing = screen.queryByRole('button', { name: ht['stock.refreshing'] });
  const button = refresh ?? refreshing;
  if (!button) throw new Error('The stock screen has no refresh button');
  return button as HTMLButtonElement;
}

export function typeSearch(value: string): void {
  fireEvent.change(searchInput(), { target: { value } });
}

/** The variant cards on screen, named by their product heading. */
export function stockHeadings(): string[] {
  return screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
}
