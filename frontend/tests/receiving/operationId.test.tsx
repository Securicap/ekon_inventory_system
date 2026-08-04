import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, offline } from '../helpers/fetchMock.js';
import { productFixture, variantIdOf } from '../helpers/fixtures.js';
import {
  fillReceivingForm,
  openReceiving,
  receiptResponse,
  receiveRequests,
  submitButton,
  submitReceivingForm,
  RECEIVE_ROUTE,
} from '../helpers/receiving.js';
import { settle } from '../helpers/renderApp.js';

/**
 * The operation id: the one thing that makes a retry at a shop counter safe.
 *
 * It names the *intent* — this delivery, this many, here, at this time — not
 * the attempt. So it is generated once when a receipt begins, sent unchanged by
 * every retry of that receipt, and replaced only when somebody deliberately
 * starts a different one. Get that wrong in either direction and the damage is
 * real and permanent: a fresh id per attempt books the same delivery twice, and
 * a reused id across two different deliveries loses one of them.
 *
 * These tests assert the lifecycle rather than the existence of an id.
 */

const RICE = productFixture();

/** UUIDv7: the version nibble and the variant bits, not merely "some string". */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fillValidReceipt(overrides: { quantity?: string } = {}): void {
  fillReceivingForm({
    variantId: variantIdOf(RICE),
    quantity: overrides.quantity ?? '12',
    occurredAtLocal: '2026-08-04T14:30',
  });
}

describe('one receipt, one operation id', () => {
  it('sends a valid UUIDv7', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });
    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('status');

    expect(receiveRequests(api)[0]?.operationId).toMatch(UUID_V7);
  });

  it('sends the same id in the body and in the header', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });
    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('status');

    const request = api.to(RECEIVE_ROUTE)[0]!;
    expect(request.headers['x-ekon-operation-id']).toBe(
      (request.body as { operationId: string }).operationId,
    );
  });

  it('is not stored in the browser', async () => {
    // A shared shop laptop that remembered a half-finished delivery would show
    // it to whoever sat down next, and a stored id would outlive its intent.
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });
    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('status');

    const operationId = String(receiveRequests(api)[0]?.operationId);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(
      operationId,
    );
  });
});

describe('retrying an uncertain receipt', () => {
  it('sends the identical command again after the connection dropped', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: [offline(), json(receiptResponse(), 201)] });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retrySame'] }));
    await screen.findByRole('status');

    const [first, second] = receiveRequests(api);
    expect(second).toEqual(first);
    expect(second?.operationId).toMatch(UUID_V7);
  });

  it('sends the identical command again after an unexplained server failure', async () => {
    const api = await openReceiving({
      [RECEIVE_ROUTE]: [apiFailure('INTERNAL', 500), json(receiptResponse(), 201)],
    });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retrySame'] }));
    await screen.findByRole('status');

    const [first, second] = receiveRequests(api);
    expect(second?.operationId).toBe(first?.operationId);
    expect(second).toEqual(first);
  });

  it('does not regenerate the id, and does not retry by itself', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: offline() });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');
    await settle();

    // One attempt, and it is waiting for a person to decide. Writes are never
    // retried behind somebody's back, however safe the server makes it.
    expect(receiveRequests(api)).toHaveLength(1);
  });

  it('sends one request however many times the button is pressed', async () => {
    const pending = deferred();
    const api = await openReceiving({ [RECEIVE_ROUTE]: pending.responder });

    fillValidReceipt();
    const form = submitButton().closest('form')!;

    submitReceivingForm();
    submitReceivingForm();
    // And by keyboard, past the disabled button, which is the way a double
    // submission actually happens.
    fireEvent.submit(form);
    await settle();

    expect(receiveRequests(api)).toHaveLength(1);
    expect(submitButton()).toBeDisabled();

    pending.resolve(json(receiptResponse(), 201));
    await screen.findByRole('status');
    expect(receiveRequests(api)).toHaveLength(1);
  });
});

describe('starting a different receipt', () => {
  it('generates a new id after a successful one', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.receiveAnother'] }));
    fillValidReceipt({ quantity: '3' });
    submitReceivingForm();
    await settle();

    const [first, second] = receiveRequests(api);
    expect(second?.operationId).not.toBe(first?.operationId);
    expect(second?.operationId).toMatch(UUID_V7);
  });

  it('generates a new id when a failed attempt is abandoned', async () => {
    const api = await openReceiving({
      [RECEIVE_ROUTE]: [offline(), json(receiptResponse(), 201)],
    });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');

    // Abandoning is deliberate and explicit — never something that happens
    // because somebody touched a field.
    fireEvent.click(screen.getByRole('button', { name: ht['receiving.startNew'] }));
    await settle();
    fillValidReceipt({ quantity: '9' });
    submitReceivingForm();
    await screen.findByRole('status');

    const [first, second] = receiveRequests(api);
    expect(second?.operationId).not.toBe(first?.operationId);
    expect(second?.quantity).toBe(9);
  });

  it('clears the item and the quantity, and keeps the counter, for the next delivery', async () => {
    await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.receiveAnother'] }));

    expect((screen.getByLabelText(ht['receiving.variant']) as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText(ht['receiving.quantity']) as HTMLInputElement).value).toBe('');
    // Deliveries arrive at the same counter; re-choosing it every time is
    // friction for no safety.
    expect((screen.getByLabelText(ht['receiving.location']) as HTMLSelectElement).value).not.toBe(
      '',
    );
  });
});

describe('the retry a shop actually performs', () => {
  it('books the delivery once when the first attempt reached the server but the answer did not', async () => {
    /**
     * The central case this whole design exists for. The request arrives, the
     * movement is posted, and the connection dies before the response gets
     * back — so the browser cannot tell "it failed" from "it worked and I did
     * not hear". The employee presses the button again.
     *
     * The second request carries the same operation id and the same fields, so
     * the server recognizes the repeat and answers with the movement it already
     * posted. The shelf holds 37, not 74.
     */
    const original = receiptResponse({ quantityAfter: 37 });
    const api = await openReceiving({
      [RECEIVE_ROUTE]: [offline(), json(original, 201)],
    });

    fillValidReceipt();
    submitReceivingForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retrySame'] }));
    await screen.findByRole('status');

    const [first, second] = receiveRequests(api);
    expect(receiveRequests(api)).toHaveLength(2);

    // Same command, in every field the server hashes.
    expect(second?.operationId).toBe(first?.operationId);
    expect(second?.variantId).toBe(first?.variantId);
    expect(second?.locationId).toBe(first?.locationId);
    expect(second?.quantity).toBe(first?.quantity);
    expect(second?.occurredAt).toBe(first?.occurredAt);

    // One success, showing the balance the server actually holds.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('37');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
