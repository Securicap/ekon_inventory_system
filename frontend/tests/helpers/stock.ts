import { fireEvent, screen, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi, type FetchMock, type Responder } from './fetchMock.js';
import { balanceFixture, userFixture, userResponse } from './fixtures.js';
import { renderApp, settle } from './renderApp.js';
import { viewport, type Viewport } from './viewport.js';

/**
 * Signs somebody in who may read stock, and opens the stock screen the way they
 * would: by clicking the navigation entry.
 *
 * No shortcut past authentication and no shortcut past the shell — the screen
 * is reached through the same capability check that decides whether it is
 * offered at all. Stock is an everyday destination, so it is one press away in
 * all three chromes and this helper needs no width-specific route to it.
 */

export const BALANCES_ROUTE = 'GET /api/inventory/balances';

export async function openStock(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[]; viewport?: Viewport } = {},
): Promise<{ api: FetchMock; queryClient: QueryClient }> {
  // Before rendering: `useBreakpoint` reads `matchMedia` on the first render,
  // and jsdom has none of its own — which is why every test that does not ask
  // for a width gets the desktop shell.
  if (options.viewport) viewport(options.viewport);

  const api = mockApi({
    'GET /api/auth/me': json(
      userResponse(userFixture({ capabilities: options.capabilities ?? ['inventory.read'] })),
    ),
    [BALANCES_ROUTE]: json([balanceFixture()]),
    ...routes,
  });

  const { queryClient } = renderApp();
  // The navigation entry rather than the signed-in name: the rail shows
  // initials at tablet width, and the entry is what this helper is about to
  // press in every chrome.
  fireEvent.click(await screen.findByRole('button', { name: ht['nav.stock'] }));
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

/**
 * The product name of every stock record on screen, in the order it is read.
 *
 * Deliberately blind to which presentation is mounted: the phone stacks its
 * records under an `h3`, and the two tables give each row a `<th scope="row">`.
 * A search test cares that "Diri" is on screen and "Lwil" is not, and it should
 * not have to be rewritten because the browser is 400px wider.
 *
 * The tablet row header stacks the product name, the variant, and the SKU in
 * one cell, so the first element inside it is the name; the desktop one is the
 * name and nothing else, and falls through to its own text.
 */
export function stockHeadings(): string[] {
  const records = screen.queryAllByRole('heading', { level: 3 });
  if (records.length > 0) return records.map((heading) => heading.textContent ?? '');

  return screen
    .queryAllByRole('rowheader')
    .map((header) => header.firstElementChild?.textContent ?? header.textContent ?? '');
}

/**
 * One stock record, as a person reads it: the table row or the phone record
 * carrying that product, with every fact about it inside.
 */
export function stockRecord(productName: string): HTMLElement {
  const heading = screen.queryAllByRole('heading', { level: 3 });
  const record = heading.find((node) => node.textContent === productName)?.closest('li');
  if (record) return record;

  const row = screen
    .queryAllByRole('rowheader')
    .find((header) => (header.firstElementChild?.textContent ?? header.textContent) === productName)
    ?.closest('tr');
  if (!row) throw new Error(`No stock record for ${productName}`);
  return row;
}

/** The shelf names and quantities inside one record, paired as they are read. */
export function locationLines(record: HTMLElement): Array<[string, string]> {
  const terms = within(record).queryAllByRole('term');
  const quantities = within(record).queryAllByRole('definition');
  return terms.map((term, index) => [term.textContent ?? '', quantities[index]?.textContent ?? '']);
}
