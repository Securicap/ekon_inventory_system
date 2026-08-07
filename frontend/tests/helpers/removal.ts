import { fireEvent, screen } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi, type FetchMock, type Responder } from './fetchMock.js';
import { balanceFixture, userFixture, userResponse } from './fixtures.js';
import { renderApp, settle } from './renderApp.js';

/**
 * Signs somebody in who may remove stock, and opens the removal screen the way
 * they would: by clicking the navigation entry.
 *
 * No shortcut past authentication and no shortcut past the shell — the screen
 * is reached through the same capability check that decides whether it is
 * offered at all.
 */

export const REMOVE_ROUTE = 'POST /api/inventory/remove';
export const BALANCES_ROUTE = 'GET /api/inventory/balances';

/** What the counter's default fixture holds: rice on two shelves, oil on one. */
export const RICE = balanceFixture({
  productName: 'Diri',
  sku: 'EKN-AB12CD34',
  attributes: [{ name: 'gwosè', value: '5 mamit' }],
  locations: [
    { locationName: 'Main Store', isDefault: true, quantity: 10 },
    { locationName: 'Backroom', isDefault: false, quantity: 4 },
  ],
});

export const OIL = balanceFixture({
  productId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02',
  productName: 'Lwil',
  sku: 'EKN-Z9Y8X7W6',
  locations: [{ locationName: 'Main Store', isDefault: true, quantity: 3 }],
});

export async function openRemoval(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[] } = {},
): Promise<{ api: FetchMock; queryClient: QueryClient }> {
  const api = mockApi({
    'GET /api/auth/me': json(
      userResponse(
        userFixture({
          capabilities: options.capabilities ?? ['inventory.read', 'inventory.remove'],
        }),
      ),
    ),
    [BALANCES_ROUTE]: json([RICE, OIL]),
    ...routes,
  });

  const { queryClient } = renderApp();
  await screen.findByText('Marie Joseph');
  fireEvent.click(screen.getByRole('button', { name: ht['nav.remove'] }));
  await screen.findByRole('heading', { name: ht['removal.title'] });
  // The form renders before its choices arrive. Every test here is about a form
  // somebody can actually fill in, so the helper waits for the balances rather
  // than leaving each test to remember.
  await settle();

  return { api, queryClient };
}

/** The body of `POST /api/inventory/remove`, as the browser sent it. */
export function removeRequests(api: FetchMock): Record<string, unknown>[] {
  return api.to(REMOVE_ROUTE).map((request) => request.body as Record<string, unknown>);
}

export function variantSelect(): HTMLSelectElement {
  return screen.getByLabelText(ht['removal.variant']) as HTMLSelectElement;
}

export function locationSelect(): HTMLSelectElement {
  return screen.getByLabelText(ht['removal.location']) as HTMLSelectElement;
}

export function quantityInput(): HTMLInputElement {
  return screen.getByLabelText(ht['removal.quantity']) as HTMLInputElement;
}

export function reasonSelect(): HTMLSelectElement {
  return screen.getByLabelText(ht['removal.reason']) as HTMLSelectElement;
}

export function occurredAtInput(): HTMLInputElement {
  return screen.getByLabelText(ht['removal.occurredAt']) as HTMLInputElement;
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
  if (!button) throw new Error('The removal form has no submit button');
  return button;
}

/** The `<option>` values a select currently offers, and whether each is usable. */
export function options(
  select: HTMLSelectElement,
): { value: string; label: string; disabled: boolean }[] {
  return [...select.options].map((option) => ({
    value: option.value,
    label: option.textContent ?? '',
    disabled: option.disabled,
  }));
}

/** Fills whichever fields a test names, leaving the rest as they are. */
export function fillRemovalForm(values: {
  variantId?: string;
  locationId?: string;
  quantity?: string;
  reason?: string;
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
  if (values.reason !== undefined) {
    fireEvent.change(reasonSelect(), { target: { value: values.reason } });
  }
  if (values.occurredAtLocal !== undefined) {
    fireEvent.change(occurredAtInput(), { target: { value: values.occurredAtLocal } });
  }
}

export function submitRemovalForm(): void {
  fireEvent.click(submitButton());
}

/** A complete, valid removal of rice from the Main Store. */
export function fillValidRemoval(overrides: { quantity?: string; reason?: string } = {}): void {
  fillRemovalForm({
    variantId: RICE.variantId,
    locationId: RICE.locations[0]!.locationId,
    quantity: overrides.quantity ?? '3',
    reason: overrides.reason ?? 'SOLD',
    occurredAtLocal: '2026-08-06T14:30',
  });
}

/** What a successful `POST /api/inventory/remove` answers. */
export function removalResponse(overrides: { quantityAfter?: number } = {}): unknown {
  return {
    operationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01',
    movementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d01',
    quantityAfter: overrides.quantityAfter ?? 7,
  };
}
