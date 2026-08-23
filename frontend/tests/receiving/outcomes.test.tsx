import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, json, mockApi, offline, type Responder } from '../helpers/fetchMock.js';
import {
  locationFixture,
  productFixture,
  userFixture,
  userResponse,
  variantIdOf,
} from '../helpers/fixtures.js';
import {
  fillReceivingForm,
  openReceiving,
  quantityInput,
  receiptResponse,
  receiveRequests,
  submitReceivingForm,
  variantSelect,
  RECEIVE_ROUTE,
} from '../helpers/receiving.js';
import { renderApp, settle } from '../helpers/renderApp.js';

/**
 * What the employee is told once the server has answered — and what they are
 * offered next.
 *
 * Every failure here is a different sentence with a different remedy. "The
 * connection dropped" means press it again; "that item is closed" means choose
 * again; "you may not do this" means ask the owner. Rendering all of them as
 * one red box would make the screen useless at exactly the moment it matters.
 */

const RICE = productFixture({ name: 'Diri', sku: 'EKN-AB12CD34' });

function fillValidReceipt(): void {
  fillReceivingForm({
    variantId: variantIdOf(RICE),
    quantity: '12',
    occurredAtLocal: '2026-08-04T14:30',
  });
}

describe('a receipt the server accepted', () => {
  it('says what was received, where, and what is on the shelf now', async () => {
    await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse({ quantityAfter: 37 }), 201) });

    fillValidReceipt();
    submitReceivingForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('12');
    expect(confirmation).toHaveTextContent('37');
    expect(confirmation).toHaveTextContent('Main Store');
    expect(confirmation).toHaveTextContent('Diri — EKN-AB12CD34');
  });

  it('shows no ledger internals', async () => {
    const response = receiptResponse();
    await openReceiving({ [RECEIVE_ROUTE]: json(response, 201) });

    fillValidReceipt();
    submitReceivingForm();
    const confirmation = await screen.findByRole('status');

    // The movement id and the request hash are how the ledger keeps its own
    // promises. An employee cannot act on either.
    expect(confirmation.textContent ?? '').not.toContain(
      (response as { movementId: string }).movementId,
    );
    expect(confirmation.textContent ?? '').not.toMatch(/hash|RECEIPT|movement/i);
  });

  it('does not refetch the catalog or the locations it did not change', async () => {
    // Receiving moves stock. It does not create products or open counters. The
    // one read it does make stale is the current-stock balance, and that is
    // invalidated rather than refetched here — see `invalidation.test.tsx`.
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('status');
    await settle();

    expect(api.to('GET /api/catalog/products')).toHaveLength(1);
    expect(api.to('GET /api/inventory/locations')).toHaveLength(1);
  });

  it('offers a clean form for the next delivery', async () => {
    await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.receiveAnother'] }));

    expect(screen.queryByRole('status')).toBeNull();
    expect(variantSelect().value).toBe('');
    expect(quantityInput().value).toBe('');
  });

  it('moves the reader to the confirmation', async () => {
    await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillValidReceipt();
    submitReceivingForm();
    const confirmation = await screen.findByRole('status');

    expect(confirmation.parentElement).toHaveFocus();
  });
});

describe('a receipt the server refused', () => {
  async function fails(responder: Responder | Responder[]) {
    const api = await openReceiving({ [RECEIVE_ROUTE]: responder });
    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');
    return api;
  }

  it('offers a retry only when sending the same thing again could work', async () => {
    await fails(offline());

    expect(screen.getByRole('alert')).toHaveTextContent(ht['error.network']);
    expect(screen.getByRole('button', { name: ht['receiving.retrySame'] })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['receiving.startNew'] })).toBeInTheDocument();
  });

  it('explains an item or location that no longer exists, and does not offer a retry', async () => {
    await fails(apiFailure('NOT_FOUND', 404));

    expect(screen.getByRole('alert')).toHaveTextContent(ht['error.notFound']);
    // Sending the identical request again would be refused identically.
    expect(screen.queryByRole('button', { name: ht['receiving.retrySame'] })).toBeNull();
    expect(screen.getByRole('button', { name: ht['receiving.startNew'] })).toBeInTheDocument();
  });

  it('explains an item or location that has been closed', async () => {
    await fails(apiFailure('CONFLICT', 409));

    expect(screen.getByRole('alert')).toHaveTextContent(ht['error.resourceInactive']);
    expect(screen.queryByRole('button', { name: ht['receiving.retrySame'] })).toBeNull();
  });

  it('reloads the choices when the person starts again after a stale one', async () => {
    const api = await fails(apiFailure('CONFLICT', 409));

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.startNew'] }));
    await settle();

    // The lists were the problem, so the lists are re-read. This is the only
    // reason this screen ever refetches them.
    expect(api.to('GET /api/catalog/products')).toHaveLength(2);
    expect(api.to('GET /api/inventory/locations')).toHaveLength(2);
  });

  it('shows the request id, so a support call becomes a log line', async () => {
    await fails(apiFailure('INTERNAL', 500, 'req-receiving'));
    expect(screen.getByRole('alert')).toHaveTextContent('req-receiving');
  });

  it('never shows the server English', async () => {
    await fails(apiFailure('NOT_FOUND', 404));
    expect(screen.getByRole('alert')).not.toHaveTextContent('English:');
  });

  it('holds the form still until the person decides', async () => {
    // The values and the operation id belong to an attempt whose outcome is
    // unknown. Editing a field under that id would turn a retry into a
    // conflict, so the form waits rather than silently changing what it means.
    await fails(offline());

    expect(variantSelect()).toBeDisabled();
    expect(quantityInput()).toBeDisabled();
    expect(screen.getByLabelText(ht['receiving.location'])).toBeDisabled();
    expect(screen.getByLabelText(ht['receiving.occurredAt'])).toBeDisabled();
  });
});

describe('an operation id used for two different receipts', () => {
  it('says what happened, and waits for a person', async () => {
    const api = await openReceiving({
      [RECEIVE_ROUTE]: apiFailure('OPERATION_REPLAYED_WITH_DIFFERENT_BODY', 409),
    });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(ht['error.operationChanged']);
    // Nothing is sent again, and no second id is minted behind the scenes.
    expect(receiveRequests(api)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: ht['receiving.retrySame'] })).toBeNull();
  });

  it('lets the person start a new receipt, under a new id', async () => {
    const api = await openReceiving({
      [RECEIVE_ROUTE]: [
        apiFailure('OPERATION_REPLAYED_WITH_DIFFERENT_BODY', 409),
        json(receiptResponse(), 201),
      ],
    });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.startNew'] }));
    await settle();
    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('status');

    const [first, second] = receiveRequests(api);
    expect(second?.operationId).not.toBe(first?.operationId);
  });
});

describe('who the server says is asking', () => {
  it('treats a refused permission as a permission problem, not a session one', async () => {
    await openReceiving({ [RECEIVE_ROUTE]: apiFailure('FORBIDDEN', 403) });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');

    expect(screen.getByRole('alert')).toHaveTextContent(ht['error.forbidden']);
    // Still signed in. Signing in again would change nothing about a 403.
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
  });

  it('ends the session on a 401, and leaves nothing of the receipt on screen', async () => {
    // A write is a protected request like any other. Built inline rather than
    // through the helper so the test holds the same query cache the
    // application does, and can assert what the ended session removed from it.
    mockApi({
      'GET /api/auth/me': json(
        userResponse(userFixture({ capabilities: ['catalog.read', 'inventory.receive'] })),
      ),
      'GET /api/catalog/products': json([RICE]),
      'GET /api/inventory/locations': json([locationFixture()]),
      [RECEIVE_ROUTE]: apiFailure('UNAUTHENTICATED', 401),
    });
    const { queryClient } = renderApp();
    await screen.findByText('Marie Joseph');
    fireEvent.click(screen.getByRole('button', { name: ht['nav.receive'] }));
    await settle();

    fillValidReceipt();
    submitReceivingForm();

    expect(await screen.findByLabelText(ht['auth.username'])).toBeInTheDocument();
    expect(screen.getByText(ht['error.sessionExpired'])).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: ht['receiving.title'] })).toBeNull();
    expect(screen.queryByText('Marie Joseph')).toBeNull();

    // Nothing a signed-out browser could still read.
    expect(queryClient.getQueryData(['catalog', 'products'])).toBeUndefined();
    expect(queryClient.getQueryData(['inventory', 'locations'])).toBeUndefined();
  });
});

describe('choices that go stale while the screen is open', () => {
  it('drops a selected variant that is no longer offered', async () => {
    const api = await openReceiving({
      'GET /api/catalog/products': [
        json([RICE]),
        json([{ ...RICE, lifecycleStatus: 'DISCONTINUED' }]),
      ],
      [RECEIVE_ROUTE]: apiFailure('CONFLICT', 409),
    });

    fillValidReceipt();
    expect(variantSelect().value).toBe(variantIdOf(RICE));

    // The refusal is what sends the person back for fresh choices, and the
    // fresh choices no longer include what they had picked.
    submitReceivingForm();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: ht['receiving.startNew'] }));
    await settle();

    expect(api.to('GET /api/catalog/products')).toHaveLength(2);
    expect(variantSelect().value).toBe('');
    expect(await screen.findByText(ht['receiving.noVariants'])).toBeInTheDocument();
  });

  it('drops a selected location that has been closed', async () => {
    const open = locationFixture({ name: 'Main Store' });
    const api = await openReceiving({
      'GET /api/inventory/locations': [json([open]), json([{ ...open, isActive: false }])],
      [RECEIVE_ROUTE]: apiFailure('CONFLICT', 409),
    });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: ht['receiving.startNew'] }));
    await settle();

    expect(api.to('GET /api/inventory/locations')).toHaveLength(2);
    expect(screen.getByLabelText(ht['receiving.location'])).toHaveValue('');
    expect(await screen.findByText(ht['receiving.noLocations'])).toBeInTheDocument();
  });
});
