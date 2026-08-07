import { cleanup, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, offline } from '../helpers/fetchMock.js';
import { settle } from '../helpers/renderApp.js';
import {
  fillRemovalForm,
  fillValidRemoval,
  openRemoval,
  quantityInput,
  reasonSelect,
  removalResponse,
  removeRequests,
  submitButton,
  submitRemovalForm,
  variantSelect,
  REMOVE_ROUTE,
  RICE,
} from '../helpers/removal.js';

/**
 * The operation id: the one thing that makes a retry at a shop counter safe.
 *
 * It names the *intent* — this item, this many, from this shelf, for this
 * reason, at this time — not the attempt. So it is generated once when a
 * removal begins, sent unchanged by every retry of that removal, and replaced
 * only when somebody deliberately starts a different one. Get that wrong in
 * either direction and the damage is real and permanent: a fresh id per attempt
 * takes the same stock off the shelf twice, and a reused id across two
 * different removals loses one of them.
 *
 * These tests assert the lifecycle rather than the existence of an id.
 */

/** UUIDv7: the version nibble and the variant bits, not merely "some string". */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function operationIds(api: Parameters<typeof removeRequests>[0]): string[] {
  return removeRequests(api).map((body) => String(body.operationId));
}

describe('one removal, one operation id', () => {
  it('sends a valid UUIDv7', async () => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    expect(operationIds(api)[0]).toMatch(UUID_V7);
  });

  it('sends the same id in the body and in the header', async () => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    const request = api.to(REMOVE_ROUTE)[0]!;
    expect(request.headers['x-ekon-operation-id']).toBe(
      (request.body as { operationId: string }).operationId,
    );
  });

  it('is not stored in the browser', async () => {
    // A shared shop laptop that remembered a half-finished removal would show
    // it to whoever sat down next, and a stored id would outlive its intent.
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(
      operationIds(api)[0]!,
    );
  });

  it('is not minted per press: two presses while one is in flight send one request', async () => {
    const slow = deferred();
    const { api } = await openRemoval({ [REMOVE_ROUTE]: slow.responder });
    fillValidRemoval();

    submitRemovalForm();
    await screen.findByRole('button', { name: ht['removal.submitting'] });
    submitRemovalForm();
    submitRemovalForm();
    await settle();

    expect(api.to(REMOVE_ROUTE)).toHaveLength(1);

    slow.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
    expect(api.to(REMOVE_ROUTE)).toHaveLength(1);
  });
});

describe('a removal whose outcome is unknown', () => {
  it('retries under the same id after a dropped connection', async () => {
    // The scenario the whole design is for: the request reached the server, the
    // response did not come back, and the employee presses again. The server
    // recognizes the repeat and answers with the movement it already posted.
    const { api } = await openRemoval({
      [REMOVE_ROUTE]: [offline(), json(removalResponse({ quantityAfter: 7 }), 201)],
    });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: ht['removal.retrySame'] }));
    await screen.findByRole('status');

    const [first, second] = removeRequests(api);
    expect(second!.operationId).toBe(first!.operationId);
    // The same command, byte for byte — not merely the same id.
    expect(second).toEqual(first);
    // And one confirmed removal, not two.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('retries under the same id after a server fault', async () => {
    const { api } = await openRemoval({
      [REMOVE_ROUTE]: [apiFailure('INTERNAL', 500), json(removalResponse(), 201)],
    });
    fillValidRemoval();
    submitRemovalForm();

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: ht['removal.retrySame'] }));
    await screen.findByRole('status');

    const ids = operationIds(api);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it('freezes the command it sent, so nothing can be edited under that id', async () => {
    // Editing a field under an id whose outcome is unknown would turn a safe
    // retry into a conflict. The choice is explicit rather than implied by
    // typing.
    await openRemoval({ [REMOVE_ROUTE]: offline() });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('alert');

    expect(variantSelect()).toBeDisabled();
    expect(quantityInput()).toBeDisabled();
    expect(reasonSelect()).toBeDisabled();
    expect(submitButton()).toBeDisabled();
  });

  it('mints a new id when the employee abandons it and starts again', async () => {
    const { api } = await openRemoval({
      [REMOVE_ROUTE]: [offline(), json(removalResponse(), 201)],
    });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['removal.startNew'] }));
    fillValidRemoval({ quantity: '2' });
    submitRemovalForm();
    await screen.findByRole('status');

    const ids = operationIds(api);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[1]).toMatch(UUID_V7);
  });
});

describe('a removal the server definitively refused', () => {
  it('carries a corrected removal under a new id', async () => {
    // The shelf did not hold enough, the transaction rolled back, and the
    // command has to change. A changed command is a new removal — reusing the
    // id for a different quantity would make the lifecycle unreadable.
    const { api } = await openRemoval({
      [REMOVE_ROUTE]: [apiFailure('INSUFFICIENT_STOCK', 422), json(removalResponse(), 201)],
    });
    fillValidRemoval({ quantity: '9' });
    submitRemovalForm();
    await screen.findByRole('alert');

    // No retry-the-same path is offered at all.
    expect(screen.queryByRole('button', { name: ht['removal.retrySame'] })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: ht['removal.startNew'] }));
    fillValidRemoval({ quantity: '2' });
    submitRemovalForm();
    await screen.findByRole('status');

    const ids = operationIds(api);
    expect(ids[1]).not.toBe(ids[0]);
    expect(removeRequests(api)[1]?.quantity).toBe(2);
  });

  it('offers no retry for a conflict, a refusal, or a gone item', async () => {
    for (const [code, status] of [
      ['OPERATION_REPLAYED_WITH_DIFFERENT_BODY', 409],
      ['CONFLICT', 409],
      ['NOT_FOUND', 404],
      ['FORBIDDEN', 403],
      ['VALIDATION_FAILED', 400],
    ] as const) {
      await openRemoval({ [REMOVE_ROUTE]: apiFailure(code, status) });
      fillValidRemoval();
      submitRemovalForm();
      await screen.findByRole('alert');

      expect(
        screen.queryByRole('button', { name: ht['removal.retrySame'] }),
        `${code} should not invite a retry`,
      ).toBeNull();
      expect(screen.getByRole('button', { name: ht['removal.startNew'] })).toBeInTheDocument();
      cleanup();
    }
  });
});

describe('after a confirmed removal', () => {
  it('mints a new id for the next item', async () => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: ht['removal.removeAnother'] }));
    fillValidRemoval({ quantity: '1' });
    submitRemovalForm();
    await screen.findAllByRole('status');

    const ids = operationIds(api);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('clears the shelf as well as the item, so nothing carries over', async () => {
    // A second removal is rarely the same item from the same shelf, and a
    // location left over from the previous one is a wrong shelf that looks
    // deliberate. Taking stock off the wrong shelf is not a mistake a
    // confirmation screen catches.
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: ht['removal.removeAnother'] }));

    expect(variantSelect().value).toBe('');
    expect(quantityInput().value).toBe('');
    expect(reasonSelect().value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('an idempotent replay, end to end', () => {
  it('shows one confirmed removal for two identical requests', async () => {
    // 1. the request reaches the server and the stock moves;
    // 2. the response is lost on the way back;
    // 3. the employee presses retry;
    // 4. the server recognizes the repeat and answers with the same movement.
    const { api } = await openRemoval({
      [REMOVE_ROUTE]: [offline(), json(removalResponse({ quantityAfter: 7 }), 201)],
    });
    fillRemovalForm({
      variantId: RICE.variantId,
      locationId: RICE.locations[0]!.locationId,
      quantity: '3',
      reason: 'DAMAGED',
      occurredAtLocal: '2026-08-06T14:30',
    });
    submitRemovalForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['removal.retrySame'] }));
    const confirmation = await screen.findByRole('status');

    const [first, second] = removeRequests(api);
    expect(second).toEqual(first);
    expect(second!.operationId).toBe(first!.operationId);
    expect(second!.quantity).toBe(3);
    expect(second!.reason).toBe('DAMAGED');

    // One success on screen, and it reports what the server answered.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(confirmation).toHaveTextContent('7');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
