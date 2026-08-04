import { fireEvent, screen } from '@testing-library/react';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi, type FetchMock, type Responder } from './fetchMock.js';
import { locationFixture, productFixture, userFixture, userResponse } from './fixtures.js';
import { renderApp, settle } from './renderApp.js';

/**
 * Signs somebody in who may receive stock, and opens the receiving screen the
 * way they would: by clicking the navigation entry.
 *
 * No shortcut past authentication and no shortcut past the shell — the screen
 * is reached through the same capability check that decides whether it is
 * offered at all.
 */

export const RECEIVE_ROUTE = 'POST /api/inventory/receive';

export async function openReceiving(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[] } = {},
): Promise<FetchMock> {
  const api = mockApi({
    'GET /api/auth/me': json(
      userResponse(
        userFixture({
          capabilities: options.capabilities ?? [
            'catalog.read',
            'inventory.read',
            'inventory.receive',
          ],
        }),
      ),
    ),
    'GET /api/catalog/products': json([productFixture()]),
    'GET /api/inventory/locations': json([locationFixture()]),
    ...routes,
  });

  renderApp();
  await screen.findByText('Marie Joseph');
  fireEvent.click(screen.getByRole('button', { name: ht['nav.receive'] }));
  await screen.findByRole('heading', { name: ht['receiving.title'] });
  // The form renders before its choices arrive. Every test here is about a form
  // somebody can actually fill in, so the helper waits for the catalog and the
  // locations rather than leaving each test to remember.
  await settle();

  return api;
}

/** The body of `POST /api/inventory/receive`, as the browser sent it. */
export function receiveRequests(api: FetchMock): Record<string, unknown>[] {
  return api.to(RECEIVE_ROUTE).map((request) => request.body as Record<string, unknown>);
}

export function variantSelect(): HTMLSelectElement {
  return screen.getByLabelText(ht['receiving.variant']) as HTMLSelectElement;
}

export function locationSelect(): HTMLSelectElement {
  return screen.getByLabelText(ht['receiving.location']) as HTMLSelectElement;
}

export function quantityInput(): HTMLInputElement {
  return screen.getByLabelText(ht['receiving.quantity']) as HTMLInputElement;
}

export function occurredAtInput(): HTMLInputElement {
  return screen.getByLabelText(ht['receiving.occurredAt']) as HTMLInputElement;
}

/**
 * The form's submit control, found by what it is rather than by what it says —
 * its label changes to the submitting state, and a test that pressed it twice
 * would otherwise stop being able to find it exactly when that matters.
 */
export function submitButton(): HTMLButtonElement {
  const button = screen
    .getAllByRole('button')
    .find(
      (element): element is HTMLButtonElement => (element as HTMLButtonElement).type === 'submit',
    );
  if (!button) throw new Error('The receiving form has no submit button');
  return button;
}

/** Fills whichever fields a test names, leaving the rest as they are. */
export function fillReceivingForm(values: {
  variantId?: string;
  locationId?: string;
  quantity?: string;
  occurredAtLocal?: string;
}): void {
  if (values.variantId !== undefined) {
    fireEvent.change(variantSelect(), { target: { value: values.variantId } });
  }
  if (values.locationId !== undefined) {
    fireEvent.change(locationSelect(), { target: { value: values.locationId } });
  }
  if (values.quantity !== undefined) {
    fireEvent.change(quantityInput(), { target: { value: values.quantity } });
  }
  if (values.occurredAtLocal !== undefined) {
    fireEvent.change(occurredAtInput(), { target: { value: values.occurredAtLocal } });
  }
}

export function submitReceivingForm(): void {
  fireEvent.click(submitButton());
}

/** What a successful `POST /api/inventory/receive` answers. */
export function receiptResponse(overrides: { quantityAfter?: number } = {}): unknown {
  return {
    operationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01',
    movementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d01',
    quantityAfter: overrides.quantityAfter ?? 37,
  };
}
