import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, offline, type Responder } from '../helpers/fetchMock.js';
import { movementFixture, page } from '../helpers/fixtures.js';
import {
  BALANCES_ROUTE,
  MOVEMENTS_ROUTE,
  REVERSER,
  REVERSE_ROUTE,
  openHistory,
} from '../helpers/history.js';
import { settle } from '../helpers/renderApp.js';

/**
 * Undoing one movement — by adding another.
 *
 * The wording is the design. This dialog never says *delete*, *undo* or *remove
 * record*, because none of those is what happens: the original stays in the
 * ledger exactly as it was and a compensating movement is appended beside it.
 * Somebody who thinks they erased a mistake will be surprised later by a
 * history that still shows it, and a person surprised by their own inventory
 * system stops trusting it.
 */

const RECEIPT = movementFixture({ movementType: 'RECEIPT', quantityDelta: 10, quantityBefore: 0 });

/**
 * What the route answers: a movement result, which is the same shape every
 * posting command returns — the operation echoed back, the movement it made,
 * and where the shelf landed. Nothing about the reversal is special, which is
 * the point of appending one rather than editing anything.
 */
const REVERSAL_RESULT = {
  operationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4908',
  movementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e09',
  quantityAfter: 0,
};

async function openReverse(
  movement = RECEIPT,
  routes: Record<string, Responder | Responder[]> = {},
): Promise<Awaited<ReturnType<typeof openHistory>>> {
  const opened = await openHistory(
    { [MOVEMENTS_ROUTE]: json(page([movement])), ...routes },
    { capabilities: REVERSER },
  );
  const opener = screen.getByRole('button', { name: ht['history.reverse'] });
  // Focused before it is pressed: a synthetic click does not move focus, and
  // the dialog hands focus back to whatever it remembers opened it.
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole('dialog');
  return opened;
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

function confirm(): void {
  const buttons = within(dialog()).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1]!);
}

describe('what the dialog says', () => {
  it('says the original stays in history', async () => {
    await openReverse();

    expect(within(dialog()).getByText(ht['history.reverseExplains'])).toBeInTheDocument();
  });

  it('never says delete, undo, or remove the record', async () => {
    // The regression guard on the one word that would make this dialog a lie.
    await openReverse();

    const body = (dialog().textContent ?? '').toLowerCase();
    for (const forbidden of ['efase', 'siprime', 'delete', 'supprimer']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('says what it will do to stock as it is now', async () => {
    // Reversing a receipt of ten takes ten off the shelf *as it is now*, not
    // off the shelf as it was that morning.
    await openReverse();

    expect(
      within(dialog()).getByText(ht['history.reverseWillApply'].replace('{delta}', '−10')),
    ).toBeInTheDocument();
  });

  it('says the opposite for a movement that took stock out', async () => {
    const sale = movementFixture({
      movementType: 'ISSUE',
      quantityDelta: -2,
      quantityBefore: 10,
      reasonCode: 'SOLD',
    });
    await openReverse(sale);

    expect(
      within(dialog()).getByText(ht['history.reverseWillApply'].replace('{delta}', '+2')),
    ).toBeInTheDocument();
  });

  it('names the movement the way the feed named it', async () => {
    // So nobody confirms against a description they have to match up themselves.
    await openReverse();

    const body = dialog();
    expect(within(body).getByText(/EKN-AB12CD34/)).toBeInTheDocument();
    expect(within(body).getByText('Main Store')).toBeInTheDocument();
    expect(within(body).getByText(`${ht['movement.receipt']} +10`)).toBeInTheDocument();
  });

  it('reads as the serious act it is', async () => {
    // Colour is the second signal; the sentences above are the first. What is
    // asserted here is that the dialog does not present a stock correction as
    // an ordinary save.
    await openReverse();

    const buttons = within(dialog()).getAllByRole('button');
    expect(buttons[buttons.length - 1]).toHaveTextContent(ht['history.reverseConfirm']);
  });
});

describe('what the request carries', () => {
  it('names a movement and nothing about the stock', async () => {
    // The variant, the location, the quantity and the direction all come from
    // the original row. A screen could not send them if it wanted to — the
    // shared schema refuses each one — which is what makes "reverse this" a
    // safe thing to put behind a button.
    const { api } = await openReverse(RECEIPT, { [REVERSE_ROUTE]: json(REVERSAL_RESULT) });

    confirm();
    await settle();

    const body = api.to(REVERSE_ROUTE)[0]?.body as Record<string, unknown>;
    expect(body.movementId).toBe(RECEIPT.id);
    expect(body).not.toHaveProperty('quantity');
    expect(body).not.toHaveProperty('variantId');
    expect(body).not.toHaveProperty('locationId');
  });

  it('omits an empty note rather than sending an empty string', async () => {
    const { api } = await openReverse(RECEIPT, { [REVERSE_ROUTE]: json(REVERSAL_RESULT) });

    confirm();
    await settle();

    expect(api.to(REVERSE_ROUTE)[0]?.body).not.toHaveProperty('note');
  });

  it('carries the note when somebody wrote why', async () => {
    const { api } = await openReverse(RECEIPT, { [REVERSE_ROUTE]: json(REVERSAL_RESULT) });

    fireEvent.change(within(dialog()).getByLabelText(ht['history.reverseNote']), {
      target: { value: 'Bwat la pa t janm rive' },
    });
    confirm();
    await settle();

    expect(api.to(REVERSE_ROUTE)[0]?.body).toMatchObject({ note: 'Bwat la pa t janm rive' });
  });

  it('keeps one operation id across a retry', async () => {
    // A dropped connection is answered by pressing the button again, and the
    // server recognises the repeat and returns the reversal it already posted.
    // A fresh id per press would turn that protection off from the outside.
    const { api } = await openReverse(RECEIPT, {
      [REVERSE_ROUTE]: [offline(), json(REVERSAL_RESULT)],
    });

    confirm();
    await settle();
    confirm();
    await settle();

    const bodies = api.to(REVERSE_ROUTE).map((request) => request.body as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.operationId).toBe(bodies[1]!.operationId);
  });

  it('does not send twice while the correction is in flight', async () => {
    const pending = deferred();
    const { api } = await openReverse(RECEIPT, { [REVERSE_ROUTE]: pending.responder });

    confirm();
    await settle();
    confirm();
    await settle();

    expect(api.to(REVERSE_ROUTE)).toHaveLength(1);
    pending.resolve(json(REVERSAL_RESULT));
    await settle();
  });
});

describe('afterwards', () => {
  it('re-reads the ledger and the shelf', async () => {
    // The ledger has a new movement and the shelf has a new quantity.
    const { api } = await openReverse(RECEIPT, { [REVERSE_ROUTE]: json(REVERSAL_RESULT) });

    const movementsBefore = api.to(MOVEMENTS_ROUTE).length;
    const balancesBefore = api.to(BALANCES_ROUTE).length;

    confirm();
    await settle();

    expect(api.to(MOVEMENTS_ROUTE).length).toBeGreaterThan(movementsBefore);
    expect(api.to(BALANCES_ROUTE).length).toBeGreaterThan(balancesBefore);
  });

  it('leaves the counts alone', async () => {
    // Reversing a reconciliation's movement does not un-count anything, and the
    // count record keeps saying what it always said.
    const { api } = await openReverse(RECEIPT, { [REVERSE_ROUTE]: json(REVERSAL_RESULT) });

    const countsBefore = api.requests.filter((request) =>
      request.url.startsWith('/api/inventory/counts'),
    ).length;

    confirm();
    await settle();

    expect(
      api.requests.filter((request) => request.url.startsWith('/api/inventory/counts')).length,
    ).toBe(countsBefore);
  });

  it('closes the dialog', async () => {
    await openReverse(RECEIPT, { [REVERSE_ROUTE]: json(REVERSAL_RESULT) });

    confirm();
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('when the server refuses', () => {
  it('says a shelf that cannot give the stock back is exactly that', async () => {
    // Not "something went wrong". The shop sold some since the receipt, and the
    // stock floor is what stops the shelf going negative.
    await openReverse(RECEIPT, { [REVERSE_ROUTE]: apiFailure('INSUFFICIENT_STOCK', 409) });

    confirm();
    await settle();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('keeps the dialog open on a conflict, so nobody is left guessing', async () => {
    await openReverse(RECEIPT, { [REVERSE_ROUTE]: apiFailure('CONFLICT', 409) });

    confirm();
    await settle();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('the dialog itself', () => {
  it('closes on Escape without correcting anything', async () => {
    const { api } = await openReverse();

    fireEvent.keyDown(dialog(), { key: 'Escape' });
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.to(REVERSE_ROUTE)).toHaveLength(0);
  });

  it('returns focus to the row control that opened it', async () => {
    await openReverse();

    fireEvent.click(within(dialog()).getByRole('button', { name: ht['action.cancel'] }));
    await settle();

    expect(screen.getByRole('button', { name: ht['history.reverse'] })).toHaveFocus();
  });
});
