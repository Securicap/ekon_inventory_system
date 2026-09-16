import { fireEvent, screen } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi, type FetchMock, type Responder } from './fetchMock.js';
import { balanceFixture, page, userFixture, userResponse } from './fixtures.js';
import { renderApp, settle } from './renderApp.js';

/**
 * Signs somebody in who may see stock, and opens Counts the way they would.
 *
 * Counts rides on `inventory.read` — seeing what has been counted is inventory
 * visibility — and recording an observation or accepting a difference needs
 * `inventory.count`, which is gated on the screen rather than at the door. So
 * the default capability here is the *reader's*, and a test that wants the
 * whole workflow asks for the second one explicitly.
 */

/** The two feeds the screen reads, keyed as the router sees them. */
export const OPEN_COUNTS_ROUTE = 'GET /api/inventory/counts?status=OPEN';
export const ALL_COUNTS_ROUTE = 'GET /api/inventory/counts?';
export const RECORD_COUNT_ROUTE = 'POST /api/inventory/counts';
export const BALANCES_ROUTE = 'GET /api/inventory/balances';

export function reconcileRoute(countId: string): string {
  return `POST /api/inventory/counts/${countId}/reconcile`;
}

/** Somebody who may walk the shelves and settle what they find. */
export const COUNTER: readonly Capability[] = ['inventory.read', 'inventory.count'];

export async function openCounts(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[] } = {},
): Promise<{ api: FetchMock; queryClient: QueryClient }> {
  const api = mockApi({
    'GET /api/auth/me': json(
      userResponse(userFixture({ capabilities: options.capabilities ?? ['inventory.read'] })),
    ),
    [OPEN_COUNTS_ROUTE]: json(page([])),
    [ALL_COUNTS_ROUTE]: json(page([])),
    // The record form offers the merchandise and the shelves from the balance
    // read; without it the form has nothing to choose from, which is a state
    // worth testing but not the one every test is about.
    [BALANCES_ROUTE]: json([balanceFixture({ locations: [{ quantity: 7 }] })]),
    ...routes,
  });

  const { queryClient } = renderApp();
  fireEvent.click(await screen.findByRole('button', { name: ht['nav.counts'] }));
  await screen.findByRole('heading', { name: ht['counts.title'] });
  await settle();

  return { api, queryClient };
}

/** Fills the record-count form the way somebody back from the shelves would. */
export function fillCount(values: { item?: string; location?: string; counted: string }): void {
  const item = screen.getByLabelText(ht['counts.item']) as HTMLSelectElement;
  fireEvent.change(item, { target: { value: values.item ?? item.options[1]?.value ?? '' } });

  const location = screen.getByLabelText(ht['counts.location']) as HTMLSelectElement;
  fireEvent.change(location, {
    target: { value: values.location ?? location.options[1]?.value ?? '' },
  });

  fireEvent.change(screen.getByLabelText(ht['counts.counted']), {
    target: { value: values.counted },
  });
}

/**
 * The form's submit control, found by what it is rather than by what it says.
 *
 * Its label changes while the request is open, and a test that pressed it twice
 * would otherwise stop being able to find it exactly when that matters.
 */
export function countSubmitButton(): HTMLButtonElement {
  const button = screen
    .getAllByRole('button')
    .find((candidate) => (candidate as HTMLButtonElement).type === 'submit');
  if (!button) throw new Error('The count form has no submit button');
  return button as HTMLButtonElement;
}

export function submitCount(): void {
  fireEvent.click(countSubmitButton());
}

/** The body of each `POST /api/inventory/counts`, as the browser sent it. */
export function recordedCounts(api: FetchMock): Record<string, unknown>[] {
  return api.to(RECORD_COUNT_ROUTE).map((request) => request.body as Record<string, unknown>);
}
