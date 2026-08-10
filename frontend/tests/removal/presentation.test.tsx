import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { translate } from '../../src/i18n/index.js';
import { inventoryBalancesQueryKey } from '../../src/lib/inventoryQueries.js';
import { apiFailure, deferred, json, offline, type FetchMock } from '../helpers/fetchMock.js';
import { settle } from '../helpers/renderApp.js';
import {
  fillRemovalForm,
  fillValidRemoval,
  occurredAtInput,
  openRemoval,
  quantityInput,
  removalResponse,
  removeRequests,
  submitButton,
  submitRemovalForm,
  variantSelect,
  BALANCES_ROUTE,
  OIL,
  REMOVE_ROUTE,
  RICE,
} from '../helpers/removal.js';

/**
 * How a removal reads while it is being entered, and after.
 *
 * The transaction semantics are asserted next door in `operationId.test.tsx`,
 * `outcomes.test.tsx`, and `form.test.tsx`, and nothing here may weaken them.
 * What this file is about is whether somebody at a counter can tell what they
 * are about to take off a shelf, whether the answer they get afterwards is the
 * server's rather than this browser's arithmetic, and — when the answer never
 * comes — whether resending the same removal and starting a different one are
 * distinguishable at a glance rather than by reading two labels carefully.
 */

function summary(): HTMLElement {
  return screen.getByRole('complementary');
}

describe('the removal being entered', () => {
  it('breaks the chosen item into product, attributes, and SKU', async () => {
    await openRemoval();
    fillRemovalForm({ variantId: RICE.variantId });

    // The `<option>` is one line; the panel under it is the hierarchy.
    expect(screen.getByText('Diri')).toBeInTheDocument();
    expect(screen.getByText('gwosè: 5 mamit')).toBeInTheDocument();
    expect(screen.getAllByText('EKN-AB12CD34').length).toBeGreaterThan(0);
  });

  it('restates the command that will be sent, and follows the form', async () => {
    await openRemoval();

    // Nothing is chosen yet, and the panel says so rather than showing zeroes.
    expect(within(summary()).getAllByText(ht['removal.notChosen']).length).toBeGreaterThan(0);

    fillValidRemoval({ quantity: '3', reason: 'DAMAGED' });

    // A minus sign, because this command takes stock away.
    expect(within(summary()).getByText('−3')).toBeInTheDocument();
    expect(within(summary()).getByText('EKN-AB12CD34')).toBeInTheDocument();
    expect(within(summary()).getByText('Main Store')).toBeInTheDocument();
    expect(within(summary()).getByText(ht['removal.reasonDamaged'])).toBeInTheDocument();
    // The business time it will carry, exactly as the control holds it.
    expect(within(summary()).getByText('2026-08-06 14:30')).toBeInTheDocument();
  });

  it('projects no balance of its own', async () => {
    // The shelf shows 10 and 3 are being taken. A panel that printed 7 would be
    // stating a quantity nothing has promised: the server decides, under the
    // row lock it already holds, and it answers with what is left.
    await openRemoval();
    fillValidRemoval({ quantity: '3' });

    expect(within(summary()).queryByText('7')).toBeNull();
    expect(within(summary()).queryByText(ht['removal.remainingLabel'])).toBeNull();
  });

  it('asks for no balances beyond the one read it already depends on', async () => {
    const { api } = await openRemoval();
    fillValidRemoval({ quantity: '3' });
    await settle();

    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
    expect(api.to('GET /api/catalog/products')).toHaveLength(0);
    expect(api.to('GET /api/inventory/locations')).toHaveLength(0);
  });

  it('says the shelf is the one stock comes off', async () => {
    await openRemoval();
    expect(screen.getByText(ht['removal.locationHint'])).toBeInTheDocument();
    expect(
      screen.getByLabelText(ht['removal.location']).getAttribute('aria-describedby'),
    ).toContain('removal-location-hint');
  });

  it('keeps the business time editable, pre-filled, and described', async () => {
    await openRemoval();

    expect(occurredAtInput().value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(occurredAtInput()).toBeEnabled();
    expect(screen.getByText(ht['removal.occurredAtHint'])).toBeInTheDocument();
    expect(occurredAtInput().getAttribute('aria-describedby')).toBe('removal-occurred-at-hint');
  });
});

describe('the quantity steppers', () => {
  function minus(): HTMLButtonElement {
    return screen.getByRole('button', { name: ht['removal.quantityMinus'] }) as HTMLButtonElement;
  }
  function plus(): HTMLButtonElement {
    return screen.getByRole('button', { name: ht['removal.quantityPlus'] }) as HTMLButtonElement;
  }

  it('writes into the same field the keyboard writes into', async () => {
    await openRemoval();
    fireEvent.change(quantityInput(), { target: { value: '4' } });

    fireEvent.click(plus());
    expect(quantityInput().value).toBe('5');

    fireEvent.click(minus());
    expect(quantityInput().value).toBe('4');
  });

  it('is not the only way to enter a quantity', async () => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });

    // Typed, never stepped, and sent as typed.
    fillValidRemoval({ quantity: '7' });
    submitRemovalForm();
    await screen.findByRole('status');

    expect(removeRequests(api)[0]?.quantity).toBe(7);
  });

  it('cannot step below one, or into a value the form would refuse', async () => {
    await openRemoval();

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

  it('does not enforce the shelf figure, which the server owns', async () => {
    // Stepping past what the last read said is allowed, exactly as typing past
    // it is, and the form says so in a sentence. A stepper that stopped at 10
    // would be a browser calculation quietly deciding a question the server
    // answers under a row lock.
    const { api } = await openRemoval();
    fillValidRemoval({ quantity: '10' });

    expect(plus()).toBeEnabled();
    fireEvent.click(plus());
    expect(quantityInput().value).toBe('11');

    submitRemovalForm();
    expect(
      await screen.findByText(ht['removal.quantityExceedsStock'].replace('{quantity}', '10')),
    ).toBeInTheDocument();
    expect(api.to(REMOVE_ROUTE)).toHaveLength(0);
  });

  it('is held still with the rest of the form after a failure', async () => {
    await openRemoval({ [REMOVE_ROUTE]: offline() });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('alert');

    // The quantity belongs to a command whose outcome is unknown. Stepping it
    // would change what the stored retry means.
    expect(minus()).toBeDisabled();
    expect(plus()).toBeDisabled();
    expect(quantityInput()).toBeDisabled();
  });
});

describe('the action that writes the removal', () => {
  it('says what it does, rather than relying on being red', async () => {
    await openRemoval();
    expect(submitButton()).toHaveAccessibleName(ht['removal.submit']);
  });

  it('reports its own flight as busy rather than as unavailable', async () => {
    const slow = deferred();
    await openRemoval({ [REMOVE_ROUTE]: slow.responder });
    fillValidRemoval();
    submitRemovalForm();

    const pending = await screen.findByRole('button', { name: ht['removal.submitting'] });
    expect(pending).toHaveAttribute('aria-busy', 'true');
    // The one place a class is worth asserting: "you may not press this" and
    // "this is working on what you pressed" are different facts, and a button
    // that went grey mid-removal would say the first when the second is true.
    expect(pending.className).toContain('bg-danger');

    slow.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
  });
});

describe('the confirmation', () => {
  it('shows the command it wrote and the quantity the server says is left', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 7 }), 201) });
    fillValidRemoval({ quantity: '3', reason: 'DAMAGED' });
    submitRemovalForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(ht['removal.removedLabel']);
    expect(confirmation).toHaveTextContent('−3');
    expect(confirmation).toHaveTextContent(ht['removal.remainingLabel']);
    expect(confirmation).toHaveTextContent(
      translate('ht', 'removal.resultingQuantity', { quantity: 7, location: 'Main Store' }),
    );
    expect(confirmation).toHaveTextContent('Diri — gwosè: 5 mamit — EKN-AB12CD34');
    expect(confirmation).toHaveTextContent(ht['removal.reasonDamaged']);
  });

  /**
   * The test that tells "show the server's result" apart from "work it out
   * here".
   *
   * The shelf was showing 10 and 3 were taken, so a browser doing the arithmetic
   * would print 7. The fixture answers 41 — schema-valid, since `quantityAfter`
   * is any non-negative integer, and it is what a shelf that somebody else
   * restocked between the read and the write genuinely looks like. Only the
   * server knows it, so only a screen that reads the response can show it.
   */
  it('reports the server figure even when it contradicts the arithmetic', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 41 }), 201) });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('41');
    expect(confirmation.textContent ?? '').not.toContain('7');
  });

  it('states no quantity from before the movement', async () => {
    // The response carries `quantityAfter` and nothing else about the shelf.
    // Adding the removed units back on to reconstruct a "before" would print
    // arithmetic dressed as a fact, so that row is absent rather than invented.
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 7 }), 201) });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation.textContent ?? '').not.toContain('10');
  });

  it('replaces the form, so what was just written cannot be sent again by reflex', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    expect(screen.queryByLabelText(ht['removal.quantity'])).toBeNull();
    expect(screen.getByRole('button', { name: ht['removal.removeAnother'] })).toBeInTheDocument();
  });
});

describe('a shelf that could not cover the removal', () => {
  async function refused(): Promise<void> {
    await openRemoval({ [REMOVE_ROUTE]: apiFailure('INSUFFICIENT_STOCK', 422, 'req-short') });
    fillValidRemoval({ quantity: '8' });
    submitRemovalForm();
    await screen.findByRole('alert');
  }

  it('is a definitive refusal, not an outcome nobody knows', async () => {
    await refused();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ht['removal.shortfallLabel']);
    expect(alert).toHaveTextContent(ht['error.insufficientStock']);
    expect(alert).toHaveTextContent(ht['removal.insufficientStock']);
    expect(alert).toHaveTextContent('req-short');

    // Never dressed as uncertainty: nothing moved, and the stock is still there.
    expect(alert).not.toHaveTextContent(ht['removal.uncertainLabel']);
    expect(screen.queryByText(ht['removal.uncertainHint'])).toBeNull();
  });

  it('offers no way to send the same command again', async () => {
    await refused();

    expect(screen.queryByText(ht['removal.retryTitle'])).toBeNull();
    expect(screen.queryByRole('button', { name: ht['removal.retrySame'] })).toBeNull();
    expect(screen.getByText(ht['removal.startNewTitle'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['removal.startNew'] })).toBeEnabled();
  });

  it('says it once, in one live region', async () => {
    await refused();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('invents no available quantity of its own', async () => {
    // What the shelf holds now is whatever the refreshed balances say. The
    // refusal states the fact and the remedy, and no number beyond them.
    await refused();
    expect(screen.getByRole('alert').textContent ?? '').not.toMatch(/\b8\b/);
  });
});

describe('an outcome nobody can be sure of', () => {
  async function uncertain(routes = {}): Promise<FetchMock> {
    const { api } = await openRemoval({
      [REMOVE_ROUTE]: [offline(), json(removalResponse({ quantityAfter: 7 }), 201)],
      ...routes,
    });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();
    await screen.findByRole('alert');
    return api;
  }

  it('says we do not know, and that the removal may already exist', async () => {
    await uncertain();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ht['removal.uncertainLabel']);
    expect(alert).toHaveTextContent(ht['removal.uncertainHint']);
    expect(alert).toHaveTextContent(ht['error.network']);
    // Not a shortfall, and not a refusal: nothing has been refused.
    expect(alert).not.toHaveTextContent(ht['removal.shortfallLabel']);
  });

  it('separates resending this removal from starting a different one', async () => {
    await uncertain();

    // Each action carries its own explanation, so neither can be pressed on the
    // assumption that it is the other.
    expect(screen.getByText(ht['removal.retryTitle'])).toBeInTheDocument();
    expect(screen.getByText(ht['removal.retryExplain'])).toBeInTheDocument();
    expect(screen.getByText(ht['removal.startNewTitle'])).toBeInTheDocument();
    expect(screen.getByText(ht['removal.startNewExplain'])).toBeInTheDocument();
  });

  it('reaches the confirmation when the resend succeeds', async () => {
    await uncertain();

    fireEvent.click(screen.getByRole('button', { name: ht['removal.retrySame'] }));

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(ht['removal.removedLabel']);
    expect(confirmation).toHaveTextContent('−3');
    expect(confirmation).toHaveTextContent('7');
    // And the uncertainty is gone, because it has been resolved.
    expect(screen.queryByText(ht['removal.uncertainLabel'])).toBeNull();
    expect(screen.queryByText(ht['removal.retryTitle'])).toBeNull();
  });

  it('stays in the failed state when the resend fails again', async () => {
    const api = await uncertain({ [REMOVE_ROUTE]: [offline(), offline()] });

    fireEvent.click(screen.getByRole('button', { name: ht['removal.retrySame'] }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(ht['removal.uncertainLabel']);
    expect(screen.getByRole('button', { name: ht['removal.retrySame'] })).toBeEnabled();
    expect(quantityInput()).toBeDisabled();
    expect(removeRequests(api)).toHaveLength(2);
    // Still the same command, twice.
    const [first, second] = removeRequests(api);
    expect(second).toEqual(first);
  });

  it('starts a different removal on a fresh id, with the form editable again', async () => {
    const api = await uncertain();

    fireEvent.click(screen.getByRole('button', { name: ht['removal.startNew'] }));
    await settle();

    expect(screen.queryByText(ht['removal.uncertainLabel'])).toBeNull();
    expect(variantSelect()).toBeEnabled();
    expect(variantSelect().value).toBe('');

    fillValidRemoval({ quantity: '2' });
    submitRemovalForm();
    await screen.findByRole('status');

    const [first, second] = removeRequests(api);
    expect(second?.operationId).not.toBe(first?.operationId);
    expect(second?.quantity).toBe(2);
  });

  it('never invalidates the shared stock cache on an outcome nobody knows', async () => {
    const { queryClient } = await openRemoval({ [REMOVE_ROUTE]: offline() });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('alert');
    await settle();

    expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(false);
  });
});

/**
 * The window between pressing "send the same removal again" and hearing back.
 *
 * The mistake this guards against is the one receiving shipped and had to fix:
 * the screen dropped back to the editing phase for the duration of the request,
 * so the explanation of what had happened and the block offering the resend both
 * vanished and the ordinary form reappeared. Somebody waiting to hear whether
 * stock had come off a shelf would instead be looking at a form, with no sign
 * that anything was in progress and nothing saying which removal it belonged to.
 */
describe('while the same removal is being resent', () => {
  /** A first attempt that fails, then a second the test resolves by hand. */
  async function retryInFlight(): Promise<{ api: FetchMock; second: ReturnType<typeof deferred> }> {
    const second = deferred();
    const { api } = await openRemoval({ [REMOVE_ROUTE]: [offline(), second.responder] });
    fillValidRemoval({ quantity: '3', reason: 'DAMAGED' });
    submitRemovalForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['removal.retrySame'] }));
    await screen.findByRole('button', { name: ht['removal.retryingSame'] });
    return { api, second };
  }

  it('sends the retry', async () => {
    const { api, second } = await retryInFlight();

    expect(removeRequests(api)).toHaveLength(2);
    second.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
  });

  it('keeps saying which removal it is, and that it is unresolved', async () => {
    const { second } = await retryInFlight();

    expect(screen.getByRole('alert')).toHaveTextContent(ht['removal.uncertainLabel']);
    expect(screen.getByRole('alert')).toHaveTextContent(ht['removal.uncertainHint']);
    expect(screen.getByText(ht['removal.retryTitle'])).toBeInTheDocument();
    expect(screen.getByText(ht['removal.retryExplain'])).toBeInTheDocument();

    second.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
  });

  it('marks the resend busy rather than merely unavailable', async () => {
    const { second } = await retryInFlight();

    const retry = screen.getByRole('button', { name: ht['removal.retryingSame'] });
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toBeDisabled();
    // Still the colour of the act it repeats, for the reason the submit button
    // is: a removal in flight must not stop looking like a removal.
    expect(retry.className).toContain('bg-danger');

    second.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
  });

  it('does not put the editable form back while it waits', async () => {
    const { second } = await retryInFlight();

    // The form is still there, still frozen — not returned to editing.
    expect(quantityInput()).toBeDisabled();
    expect(variantSelect()).toBeDisabled();
    expect(submitButton()).toBeDisabled();
    // And the submit control is not claiming to be the thing in flight.
    expect(submitButton()).toHaveAccessibleName(ht['removal.submit']);
    expect(submitButton()).toHaveAttribute('aria-busy', 'false');

    second.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
  });

  it('refuses a second resend, and refuses to start a different removal', async () => {
    const { api, second } = await retryInFlight();

    fireEvent.click(screen.getByRole('button', { name: ht['removal.retryingSame'] }));
    const startNew = screen.getByRole('button', { name: ht['removal.startNew'] });
    expect(startNew).toBeDisabled();
    fireEvent.click(startNew);
    await settle();

    // Two requests in total: the original and the one resend.
    expect(removeRequests(api)).toHaveLength(2);
    // And still the removal being waited on, not a new one.
    expect(screen.getByRole('button', { name: ht['removal.retryingSame'] })).toBeInTheDocument();

    second.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
  });

  it('is still the same command, byte for byte, under the same operation id', async () => {
    const { api, second } = await retryInFlight();

    const [first, resent] = removeRequests(api);
    expect(resent).toEqual(first);
    expect(resent?.operationId).toBe(first?.operationId);

    second.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
  });

  /**
   * The snapshot, proved rather than assumed.
   *
   * The balances refetch on their own — a window focus, a stale-choice failure
   * — and the effect that drops a selection the server no longer offers runs on
   * every one of them. If the retry rebuilt its body from the fields, a shelf
   * that fell to zero underneath would silently change what "the same removal"
   * meant. It is built once, at submission, and re-sent unchanged.
   */
  it('cannot have its payload altered by anything that happens to the form', async () => {
    const second = deferred();
    const { api } = await openRemoval({
      [BALANCES_ROUTE]: [json([RICE, OIL]), json([OIL])],
      [REMOVE_ROUTE]: [offline(), second.responder],
    });
    fillValidRemoval({ quantity: '3', reason: 'DAMAGED' });
    submitRemovalForm();
    await screen.findByRole('alert');

    // Rice is gone from the second balance answer; ask for it explicitly.
    await settle();

    fireEvent.click(screen.getByRole('button', { name: ht['removal.retrySame'] }));
    await screen.findByRole('button', { name: ht['removal.retryingSame'] });

    const [first, resent] = removeRequests(api);
    expect(resent).toEqual(first);
    expect(resent?.variantId).toBe(RICE.variantId);
    expect(resent?.locationId).toBe(RICE.locations[0]!.locationId);
    expect(resent?.quantity).toBe(3);
    expect(resent?.reason).toBe('DAMAGED');

    second.resolve(json(removalResponse(), 201));
    await screen.findByRole('status');
  });
});

describe('who may open this screen at all', () => {
  it('opens for the removal capability and no other', async () => {
    await openRemoval({}, { capabilities: ['inventory.remove', 'inventory.read'] });

    expect(screen.getByRole('heading', { name: ht['removal.title'] })).toBeInTheDocument();
    // Neither of the other two inventory doors is offered by this key.
    expect(screen.queryByRole('button', { name: ht['nav.receive'] })).toBeNull();
    expect(screen.queryByRole('button', { name: ht['nav.products'] })).toBeNull();
  });

  /**
   * The dependency this workflow already had, stated rather than changed.
   *
   * Removal is gated on `inventory.remove`, and its one read —
   * `GET /api/inventory/balances` — is gated on `inventory.read`. Somebody
   * holding only the write key reaches the screen and is refused the choices,
   * which is existing behaviour and is rendered in place: still signed in,
   * still inside the shell, and told what happened.
   */
  it('renders a refused balance read in place for a remove-only key', async () => {
    await openRemoval(
      { [BALANCES_ROUTE]: apiFailure('FORBIDDEN', 403) },
      { capabilities: ['inventory.remove'] },
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(ht['error.forbidden']);
    expect(screen.getByRole('heading', { name: ht['removal.title'] })).toBeInTheDocument();
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
  });
});
