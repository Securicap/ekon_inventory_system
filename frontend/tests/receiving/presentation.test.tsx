import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, offline, type FetchMock } from '../helpers/fetchMock.js';
import { locationFixture, productFixture, variantIdOf } from '../helpers/fixtures.js';
import {
  fillReceivingForm,
  occurredAtInput,
  openReceiving,
  quantityInput,
  receiptResponse,
  receiveRequests,
  submitReceivingForm,
  variantSelect,
  RECEIVE_ROUTE,
} from '../helpers/receiving.js';
import { settle } from '../helpers/renderApp.js';

const RICE = productFixture({
  name: 'Diri',
  sku: 'EKN-AB12CD34',
  attributes: [
    { name: 'gwosè', value: '5 mamit' },
    { name: 'mak', value: 'Tchako' },
  ],
});

const MAIN = locationFixture({ name: 'Main Store', isDefault: true });

function summary(): HTMLElement {
  return screen.getByRole('complementary');
}

async function readyToReceive(routes = {}): Promise<ReturnType<typeof openReceiving>> {
  const api = openReceiving({
    'GET /api/catalog/products': json([RICE]),
    'GET /api/inventory/locations': json([MAIN]),
    ...routes,
  });
  await api;
  return api;
}

/**
 * How a receipt reads while it is being entered, and after.
 *
 * The transaction semantics are asserted next door in `operationId.test.tsx`
 * and `outcomes.test.tsx`, and nothing here may weaken them. What this file is
 * about is whether somebody at a counter can tell what they are about to write,
 * and — when the answer never comes — whether the two ways out are
 * distinguishable at a glance rather than by reading two labels carefully.
 */
describe('the receipt being entered', () => {
  it('breaks the chosen item into product, attributes, and SKU', async () => {
    await readyToReceive();
    fireEvent.change(variantSelect(), { target: { value: variantIdOf(RICE) } });

    // The `<option>` is one line; the panel under it is the hierarchy.
    expect(screen.getByText('Diri')).toBeInTheDocument();
    expect(screen.getByText('gwosè: 5 mamit, mak: Tchako')).toBeInTheDocument();
    expect(screen.getAllByText('EKN-AB12CD34').length).toBeGreaterThan(0);
  });

  it('restates the command that will be sent, and follows the form', async () => {
    await readyToReceive();

    // The item and its SKU are not chosen yet, and the panel says so rather
    // than showing a zero. The location already reads, because the default
    // counter was filled in for them.
    expect(within(summary()).getAllByText(ht['receiving.notChosen']).length).toBe(2);
    expect(within(summary()).getByText('Main Store')).toBeInTheDocument();

    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });

    expect(within(summary()).getByText('+12')).toBeInTheDocument();
    expect(within(summary()).getByText('EKN-AB12CD34')).toBeInTheDocument();
    expect(within(summary()).getByText('Main Store')).toBeInTheDocument();
  });

  it('shows no stock figure, and asks for no balances to get one', async () => {
    // Receiving reads the catalog and the locations. A quantity-on-hand here
    // would be a third request decorating a command that does not depend on it.
    const api = await readyToReceive();
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });
    await settle();

    expect(api.to('GET /api/inventory/balances')).toHaveLength(0);
  });

  it('says why the location was already filled in, and only when it is the default', async () => {
    await readyToReceive({
      'GET /api/inventory/locations': json([
        MAIN,
        locationFixture({
          id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02',
          name: 'Depo',
          isDefault: false,
        }),
      ]),
    });

    expect(screen.getByText(ht['receiving.locationPrefilled'])).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(ht['receiving.location']), {
      target: { value: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02' },
    });
    expect(screen.queryByText(ht['receiving.locationPrefilled'])).toBeNull();
  });

  it('keeps the arrival time editable and pre-filled, as it was', async () => {
    await readyToReceive();

    expect(occurredAtInput().value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(occurredAtInput()).toBeEnabled();
    expect(screen.getByText(ht['receiving.occurredAtHint'])).toBeInTheDocument();
  });
});

describe('the quantity steppers', () => {
  function minus(): HTMLButtonElement {
    return screen.getByRole('button', { name: ht['receiving.quantityMinus'] }) as HTMLButtonElement;
  }
  function plus(): HTMLButtonElement {
    return screen.getByRole('button', { name: ht['receiving.quantityPlus'] }) as HTMLButtonElement;
  }

  it('writes into the same field the keyboard writes into', async () => {
    await readyToReceive();
    fireEvent.change(quantityInput(), { target: { value: '10' } });

    fireEvent.click(plus());
    expect(quantityInput().value).toBe('11');

    fireEvent.click(minus());
    expect(quantityInput().value).toBe('10');
  });

  it('is not the only way to enter a quantity', async () => {
    const api = await readyToReceive({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    // Typed, never stepped, and sent as typed.
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '37' });
    submitReceivingForm();
    await screen.findByRole('status');

    expect(receiveRequests(api)[0]?.quantity).toBe(37);
  });

  it('cannot step below one, or into a value the form would refuse', async () => {
    await readyToReceive();

    // Empty: neither direction has a number to work from.
    expect(minus()).toBeDisabled();
    expect(plus()).toBeDisabled();

    fireEvent.change(quantityInput(), { target: { value: '1' } });
    expect(minus()).toBeDisabled();
    expect(plus()).toBeEnabled();

    // A value the field will be told off for is left exactly as typed.
    fireEvent.change(quantityInput(), { target: { value: '2.5' } });
    expect(minus()).toBeDisabled();
    expect(plus()).toBeDisabled();
    expect(quantityInput().value).toBe('2.5');
  });

  it('is held still with the rest of the form after a failure', async () => {
    await readyToReceive({ [RECEIVE_ROUTE]: offline() });
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });
    submitReceivingForm();
    await screen.findByRole('alert');

    // The quantity belongs to a command whose outcome is unknown. Stepping it
    // would change what the stored retry means.
    expect(minus()).toBeDisabled();
    expect(plus()).toBeDisabled();
    expect(quantityInput()).toBeDisabled();
  });
});

describe('an outcome nobody can be sure of', () => {
  async function uncertain(): Promise<ReturnType<typeof openReceiving>> {
    const api = readyToReceive({ [RECEIVE_ROUTE]: [offline(), json(receiptResponse(), 201)] });
    await api;
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });
    submitReceivingForm();
    await screen.findByRole('alert');
    return api;
  }

  it('says we do not know, rather than saying it failed', async () => {
    await uncertain();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ht['receiving.uncertainLabel']);
    expect(alert).toHaveTextContent(ht['receiving.uncertainHint']);
    expect(alert).toHaveTextContent(ht['error.network']);
  });

  it('separates resending this receipt from starting a different one', async () => {
    await uncertain();

    // Each action carries its own explanation, so neither can be pressed on the
    // assumption that it is the other.
    expect(screen.getByText(ht['receiving.retryTitle'])).toBeInTheDocument();
    expect(screen.getByText(ht['receiving.retryExplain'])).toBeInTheDocument();
    expect(screen.getByText(ht['receiving.startNewTitle'])).toBeInTheDocument();
    expect(screen.getByText(ht['receiving.startNewExplain'])).toBeInTheDocument();
  });

  it('resends the identical command, under the identical operation id', async () => {
    const api = await uncertain();

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retrySame'] }));
    await screen.findByRole('status');

    const [first, second] = receiveRequests(api);
    expect(second).toEqual(first);
    expect(second?.operationId).toBe(first?.operationId);
  });

  it('reaches the confirmation when the resend succeeds', async () => {
    await uncertain();

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retrySame'] }));

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(ht['receiving.savedLabel']);
    expect(confirmation).toHaveTextContent('+12');
    // And the uncertainty is gone, because it has been resolved.
    expect(screen.queryByText(ht['receiving.uncertainLabel'])).toBeNull();
    expect(screen.queryByText(ht['receiving.retryTitle'])).toBeNull();
  });

  it('stays in the failed state when the resend fails again', async () => {
    const api = await readyToReceive({ [RECEIVE_ROUTE]: [offline(), offline()] });
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });
    submitReceivingForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retrySame'] }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(ht['receiving.uncertainLabel']);
    expect(screen.getByRole('button', { name: ht['receiving.retrySame'] })).toBeEnabled();
    expect(screen.queryByLabelText(ht['receiving.quantity'])).toBeDisabled();
    expect(receiveRequests(api)).toHaveLength(2);
    // Still the same command, twice.
    const [first, second] = receiveRequests(api);
    expect(second).toEqual(first);
  });
  it('mints a new command when the person starts a different receipt instead', async () => {
    const api = await uncertain();

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.startNew'] }));
    await settle();

    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '3' });
    submitReceivingForm();
    await screen.findByRole('status');

    const [first, second] = receiveRequests(api);
    expect(second?.operationId).not.toBe(first?.operationId);
  });

  it('offers no resend at all when the server has said something final', async () => {
    await readyToReceive({ [RECEIVE_ROUTE]: apiFailure('FORBIDDEN', 403) });
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });
    submitReceivingForm();
    await screen.findByRole('alert');

    expect(screen.queryByText(ht['receiving.retryTitle'])).toBeNull();
    expect(screen.queryByRole('button', { name: ht['receiving.retrySame'] })).toBeNull();
    expect(screen.getByText(ht['receiving.startNewTitle'])).toBeInTheDocument();
    // And it is a refusal, not an ended session: the shell is still here.
    expect(screen.getByRole('navigation', { name: ht['nav.main'] })).toBeInTheDocument();
  });
});

/**
 * The window between pressing "send the same receipt again" and hearing back.
 *
 * The mistake this guards against is subtle and was real: the screen used to
 * drop back to the editing phase for the duration of the request, so the
 * explanation of what had happened and the block offering the resend both
 * vanished and the ordinary form reappeared. Somebody waiting to hear whether
 * their delivery was written would instead be looking at a form, with no sign
 * that anything was in progress and nothing saying which receipt it belonged
 * to.
 */
describe('while the same receipt is being resent', () => {
  /** A first attempt that fails, then a second the test resolves by hand. */
  async function retryInFlight(): Promise<{ api: FetchMock; second: ReturnType<typeof deferred> }> {
    const second = deferred();
    const api = await readyToReceive({ [RECEIVE_ROUTE]: [offline(), second.responder] });
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });
    submitReceivingForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retrySame'] }));
    await screen.findByRole('button', { name: ht['receiving.retryingSame'] });
    return { api, second };
  }

  it('sends the retry', async () => {
    const { api, second } = await retryInFlight();

    expect(receiveRequests(api)).toHaveLength(2);
    second.resolve(json(receiptResponse(), 201));
    await screen.findByRole('status');
  });

  it('keeps saying which receipt it is, and that it is unresolved', async () => {
    const { second } = await retryInFlight();

    expect(screen.getByRole('alert')).toHaveTextContent(ht['receiving.uncertainLabel']);
    expect(screen.getByText(ht['receiving.retryTitle'])).toBeInTheDocument();
    expect(screen.getByText(ht['receiving.retryExplain'])).toBeInTheDocument();

    second.resolve(json(receiptResponse(), 201));
    await screen.findByRole('status');
  });

  it('marks the resend busy rather than merely unavailable', async () => {
    const { second } = await retryInFlight();

    const retry = screen.getByRole('button', { name: ht['receiving.retryingSame'] });
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toBeDisabled();

    second.resolve(json(receiptResponse(), 201));
    await screen.findByRole('status');
  });

  it('does not put the editable form back while it waits', async () => {
    const { second } = await retryInFlight();

    // The form is still there, still frozen — not returned to editing.
    expect(screen.getByLabelText(ht['receiving.quantity'])).toBeDisabled();
    expect(screen.getByLabelText(ht['receiving.variant'])).toBeDisabled();
    expect(screen.getByRole('button', { name: ht['receiving.submit'] })).toBeDisabled();

    second.resolve(json(receiptResponse(), 201));
    await screen.findByRole('status');
  });

  it('refuses a second resend, and refuses to start a different receipt', async () => {
    const { api, second } = await retryInFlight();

    fireEvent.click(screen.getByRole('button', { name: ht['receiving.retryingSame'] }));
    const startNew = screen.getByRole('button', { name: ht['receiving.startNew'] });
    expect(startNew).toBeDisabled();
    fireEvent.click(startNew);
    await settle();

    // Two requests in total: the original and the one resend.
    expect(receiveRequests(api)).toHaveLength(2);
    // And still the receipt being waited on, not a new one.
    expect(screen.getByRole('button', { name: ht['receiving.retryingSame'] })).toBeInTheDocument();

    second.resolve(json(receiptResponse(), 201));
    await screen.findByRole('status');
  });

  it('is still the same command, byte for byte, under the same operation id', async () => {
    const { api, second } = await retryInFlight();

    const [first, resent] = receiveRequests(api);
    expect(resent).toEqual(first);
    expect(resent?.operationId).toBe(first?.operationId);

    second.resolve(json(receiptResponse(), 201));
    await screen.findByRole('status');
  });
});

describe('the confirmation', () => {
  it('shows what was written and what the server says is there now', async () => {
    await readyToReceive({ [RECEIVE_ROUTE]: json(receiptResponse({ quantityAfter: 37 }), 201) });
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });
    submitReceivingForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('+12');
    expect(confirmation).toHaveTextContent(ht['receiving.savedLabel']);
    expect(confirmation).toHaveTextContent('37');
    expect(confirmation).toHaveTextContent('Main Store');
    // The whole label, so the confirmation names the item the way it was chosen.
    expect(confirmation).toHaveTextContent('Diri — gwosè: 5 mamit, mak: Tchako — EKN-AB12CD34');
  });

  it('replaces the form, so what was just written cannot be sent again by reflex', async () => {
    await readyToReceive({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });
    fillReceivingForm({ variantId: variantIdOf(RICE), locationId: MAIN.id, quantity: '12' });
    submitReceivingForm();
    await screen.findByRole('status');

    expect(screen.queryByLabelText(ht['receiving.quantity'])).toBeNull();
    expect(
      screen.getByRole('button', { name: ht['receiving.receiveAnother'] }),
    ).toBeInTheDocument();
  });
});
