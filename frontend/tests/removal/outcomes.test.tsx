import { cleanup, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { translate } from '../../src/i18n/index.js';
import { inventoryBalancesQueryKey } from '../../src/lib/inventoryQueries.js';
import { apiFailure, json, offline } from '../helpers/fetchMock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import { settle } from '../helpers/renderApp.js';
import {
  fillValidRemoval,
  locationSelect,
  openRemoval,
  removalResponse,
  removeRequests,
  submitRemovalForm,
  variantSelect,
  BALANCES_ROUTE,
  OIL,
  REMOVE_ROUTE,
  RICE,
} from '../helpers/removal.js';

/**
 * What the employee is told once the server has answered — and what they are
 * offered next.
 *
 * Every failure here is a different sentence with a different remedy. "The
 * connection dropped" means press it again; "there is not that much left" means
 * look at the new number and start again; "you may not do this" means ask the
 * owner. Rendering all of them as one red box would make the screen useless at
 * exactly the moment it matters.
 */

/** Rice, after three have been taken off the Main Store shelf. */
const RICE_AFTER = balanceFixture({
  productName: 'Diri',
  sku: 'EKN-AB12CD34',
  attributes: [{ name: 'gwosè', value: '5 mamit' }],
  locations: [
    { locationName: 'Main Store', isDefault: true, quantity: 7 },
    { locationName: 'Backroom', isDefault: false, quantity: 4 },
  ],
});

describe('a removal the server accepted', () => {
  it('says what left, from where, why, and what is left', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 7 }), 201) });
    fillValidRemoval({ quantity: '3', reason: 'DAMAGED' });
    submitRemovalForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(translate('ht', 'removal.success', { quantity: 3 }));
    expect(confirmation).toHaveTextContent(
      translate('ht', 'removal.resultingQuantity', { quantity: 7, location: 'Main Store' }),
    );
    expect(confirmation).toHaveTextContent('Diri — gwosè: 5 mamit — EKN-AB12CD34');
    expect(confirmation).toHaveTextContent('Main Store');
    // The reason, in words rather than as the code that was sent.
    expect(confirmation).toHaveTextContent(ht['removal.reasonDamaged']);
    expect(confirmation.textContent ?? '').not.toContain('DAMAGED');
  });

  it('reports emptying a shelf as the success it is', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 0 }), 201) });
    fillValidRemoval({ quantity: '10' });
    submitRemovalForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(
      translate('ht', 'removal.resultingQuantity', { quantity: 0, location: 'Main Store' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no ledger internals', async () => {
    const response = removalResponse();
    await openRemoval({ [REMOVE_ROUTE]: json(response, 201) });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();
    const confirmation = await screen.findByRole('status');

    // The movement id, the negative delta, the quantity before, the movement
    // type, the actor. An employee cannot act on any of them.
    expect(confirmation.textContent ?? '').not.toContain(
      (response as { movementId: string }).movementId,
    );
    expect(confirmation.textContent ?? '').not.toContain('-3');
    expect(confirmation.textContent ?? '').not.toMatch(/hash|ISSUE|movement|recordedAt|userId/i);
  });

  it('moves the reader to the confirmation', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    const confirmation = await screen.findByRole('status');

    expect(confirmation.parentElement).toHaveFocus();
  });

  it('offers a clean form for the next item', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: ht['removal.removeAnother'] }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(variantSelect().value).toBe('');
  });
});

describe('what a confirmed removal does to the stock everyone else is reading', () => {
  it('re-reads the shelves, and offers the next removal the new numbers', async () => {
    const { api, queryClient } = await openRemoval({
      [BALANCES_ROUTE]: [json([RICE, OIL]), json([RICE_AFTER, OIL])],
      [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 7 }), 201),
    });

    expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(false);

    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();
    await screen.findByRole('status');
    await settle();

    // The shared balance query is mounted on this very screen, so invalidating
    // it refetches immediately rather than waiting for somebody to walk to
    // Stock. Without the invalidation the query is still inside its 30-second
    // stale window and nothing would have been asked again.
    expect(api.to(BALANCES_ROUTE)).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: ht['removal.removeAnother'] }));
    fillValidRemoval({ quantity: '1' });

    // 7, not 10.
    expect(
      screen.getByText(translate('ht', 'removal.currentQuantity', { quantity: 7 })),
    ).toBeInTheDocument();
  });

  it('marks the shared key rather than refetching behind its back', async () => {
    // Asserted where the invalidation is observable: with the query unmounted,
    // it is marked stale and nothing is refetched until somebody looks.
    const { api, queryClient } = await openRemoval({
      [BALANCES_ROUTE]: [json([RICE, OIL]), json([RICE_AFTER, OIL])],
      [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 7 }), 201),
    });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();
    await screen.findByRole('status');
    await settle();

    // The stock screen reads the same key, and gets the refreshed answer.
    fireEvent.click(screen.getByRole('button', { name: ht['nav.stock'] }));
    expect(await screen.findByText('7', { selector: 'dd' })).toBeInTheDocument();
    expect(queryClient.getQueryData(inventoryBalancesQueryKey)).toBeDefined();
    expect(api.to(BALANCES_ROUTE)).toHaveLength(2);
  });

  it('keeps the confirmation even when the refetch that follows it fails', async () => {
    // The movement is permanent the moment the server answered 201. Nothing
    // about tidying a cache may reach back and unsay it.
    await openRemoval({
      [BALANCES_ROUTE]: [json([RICE, OIL]), apiFailure('INTERNAL', 500)],
      [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 7 }), 201),
    });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('7');
    await settle();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['removal.removeAnother'] })).toBeInTheDocument();
  });

  it('invalidates nothing when the removal did not happen', async () => {
    for (const responder of [
      apiFailure('INSUFFICIENT_STOCK', 422),
      apiFailure('CONFLICT', 409),
      apiFailure('VALIDATION_FAILED', 400),
      offline(),
    ]) {
      const { queryClient } = await openRemoval({ [REMOVE_ROUTE]: responder });
      fillValidRemoval();
      submitRemovalForm();
      await screen.findByRole('alert');
      await settle();

      expect(queryClient.getQueryState(inventoryBalancesQueryKey)?.isInvalidated).toBe(false);
      cleanup();
    }
  });
});

describe('a shelf that could not cover the removal', () => {
  it('says what happened and what to do, without inviting a retry', async () => {
    // The stale-UI case: the screen said 10, somebody else took eight first.
    const { api } = await openRemoval({
      [BALANCES_ROUTE]: [json([RICE, OIL]), json([RICE_AFTER, OIL])],
      [REMOVE_ROUTE]: apiFailure('INSUFFICIENT_STOCK', 422, 'req-short'),
    });
    fillValidRemoval({ quantity: '8' });
    submitRemovalForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.insufficientStock']);
    expect(alert).toHaveTextContent('req-short');
    // Never the server's English, which is written for a log line.
    expect(alert).not.toHaveTextContent('English:');

    // The instruction, distinct from the fact: the number moved, go and look.
    expect(screen.getByText(ht['removal.insufficientStock'])).toBeInTheDocument();
    // And no "send it again" — the transaction rolled back and the command has
    // to change.
    expect(screen.queryByRole('button', { name: ht['removal.retrySame'] })).toBeNull();
    expect(screen.getByRole('button', { name: ht['removal.startNew'] })).toBeInTheDocument();

    // The balances were re-read, so the corrected removal is chosen against
    // what is actually there.
    await settle();
    expect(api.to(BALANCES_ROUTE)).toHaveLength(2);
    expect(api.to(REMOVE_ROUTE)).toHaveLength(1);
  });

  it('does not resend, re-quantify, or move to another shelf by itself', async () => {
    const { api } = await openRemoval({
      [REMOVE_ROUTE]: apiFailure('INSUFFICIENT_STOCK', 422),
    });
    fillValidRemoval({ quantity: '8' });
    submitRemovalForm();
    await screen.findByRole('alert');
    await settle();

    expect(api.to(REMOVE_ROUTE)).toHaveLength(1);
    expect(removeRequests(api)[0]?.quantity).toBe(8);
    expect(removeRequests(api)[0]?.locationId).toBe(RICE.locations[0]!.locationId);
  });

  it('offers the refreshed numbers to the next attempt', async () => {
    const { api } = await openRemoval({
      [BALANCES_ROUTE]: [json([RICE, OIL]), json([RICE_AFTER, OIL])],
      [REMOVE_ROUTE]: apiFailure('INSUFFICIENT_STOCK', 422),
    });
    fillValidRemoval({ quantity: '8' });
    submitRemovalForm();
    await screen.findByRole('alert');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: ht['removal.startNew'] }));
    fillValidRemoval({ quantity: '7' });

    // 7, not 10: the shelf was re-read after the refusal.
    expect(
      screen.getByText(translate('ht', 'removal.currentQuantity', { quantity: 7 })),
    ).toBeInTheDocument();
    expect(api.to(REMOVE_ROUTE)).toHaveLength(1);
  });
});

describe('a choice that is no longer true', () => {
  it.each([
    ['a gone item or shelf', 'NOT_FOUND', 404, 'error.notFound'],
    ['a closed item or shelf', 'CONFLICT', 409, 'error.resourceInactive'],
  ] as const)(
    'says so for %s, and re-reads the shelves',
    async (_label, code, status, messageKey) => {
      const { api } = await openRemoval({
        [BALANCES_ROUTE]: [json([RICE, OIL]), json([OIL])],
        [REMOVE_ROUTE]: apiFailure(code, status),
      });
      fillValidRemoval();
      submitRemovalForm();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(ht[messageKey]);
      expect(screen.queryByRole('button', { name: ht['removal.retrySame'] })).toBeNull();

      await settle();
      expect(api.to(BALANCES_ROUTE)).toHaveLength(2);
      // Nothing was sent a second time on its own.
      expect(api.to(REMOVE_ROUTE)).toHaveLength(1);
    },
  );

  it('drops a selection the refreshed balances no longer offer', async () => {
    // Rice is gone from the response. A `<select>` still holding its id would
    // render blank and send an item nobody can see.
    await openRemoval({
      [BALANCES_ROUTE]: [json([RICE, OIL]), json([OIL])],
      [REMOVE_ROUTE]: apiFailure('CONFLICT', 409),
    });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('alert');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: ht['removal.startNew'] }));
    expect(variantSelect().value).toBe('');
    expect([...variantSelect().options].some((option) => option.value === RICE.variantId)).toBe(
      false,
    );
  });

  it('drops a shelf that has fallen to zero under the employee', async () => {
    const emptied = balanceFixture({
      productName: 'Diri',
      sku: 'EKN-AB12CD34',
      attributes: [{ name: 'gwosè', value: '5 mamit' }],
      locations: [
        { locationName: 'Main Store', isDefault: true, quantity: 0 },
        { locationName: 'Backroom', isDefault: false, quantity: 4 },
      ],
    });
    await openRemoval({
      [BALANCES_ROUTE]: [json([RICE, OIL]), json([emptied, OIL])],
      [REMOVE_ROUTE]: apiFailure('INSUFFICIENT_STOCK', 422),
    });
    fillValidRemoval({ quantity: '8' });
    submitRemovalForm();
    await screen.findByRole('alert');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: ht['removal.startNew'] }));
    fillValidRemoval({ quantity: '1' });

    // The Main Store is at zero and cannot be chosen; the form is not left
    // looking ready to send an impossible removal.
    expect(locationSelect().value).not.toBe(RICE.locations[0]!.locationId);
  });
});

describe('a removal nobody is allowed to make', () => {
  it('renders a refusal without signing anybody out', async () => {
    await openRemoval({ [REMOVE_ROUTE]: apiFailure('FORBIDDEN', 403, 'req-forbidden') });
    fillValidRemoval();
    submitRemovalForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.forbidden']);
    expect(alert).toHaveTextContent('req-forbidden');

    // Still signed in, still inside the shell, still able to leave.
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
    // And no invitation to try the same thing again.
    expect(screen.queryByRole('button', { name: ht['removal.retrySame'] })).toBeNull();
  });

  it('ends the session on a 401, and takes the form with it', async () => {
    await openRemoval({ [REMOVE_ROUTE]: apiFailure('SESSION_EXPIRED', 401) });
    fillValidRemoval();
    submitRemovalForm();

    await screen.findByLabelText(ht['auth.username']);
    expect(screen.queryByText('Marie Joseph')).toBeNull();
    expect(screen.queryByRole('heading', { name: ht['removal.title'] })).toBeNull();
    expect(screen.getByText(ht['error.sessionExpired'])).toBeInTheDocument();
  });
});

describe('a removal that changed after it was sent', () => {
  it('names the conflict and requires a deliberate fresh start', async () => {
    await openRemoval({
      [REMOVE_ROUTE]: apiFailure('OPERATION_REPLAYED_WITH_DIFFERENT_BODY', 409),
    });
    fillValidRemoval();
    submitRemovalForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.operationChanged']);
    expect(screen.queryByRole('button', { name: ht['removal.retrySame'] })).toBeNull();
    expect(screen.getByRole('button', { name: ht['removal.startNew'] })).toBeInTheDocument();
  });
});

describe('reading the shelves in the first place', () => {
  it('renders a forbidden balance read in place, without logging out', async () => {
    await openRemoval({ [BALANCES_ROUTE]: apiFailure('FORBIDDEN', 403) });

    expect(await screen.findByRole('alert')).toHaveTextContent(ht['error.forbidden']);
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
  });
});
