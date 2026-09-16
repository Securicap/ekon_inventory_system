import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { json } from '../helpers/fetchMock.js';
import { balanceFixture, movementFixture, page } from '../helpers/fixtures.js';
import {
  BALANCES_ROUTE,
  MOVEMENTS_ROUTE,
  REVERSER,
  movementRecord,
  movementsRoute,
  openHistory,
} from '../helpers/history.js';
import { settle } from '../helpers/renderApp.js';

/**
 * The evidence screen.
 *
 * Every other screen answers *what is true now*. This one answers *how it got
 * that way*, which is the question somebody asks when the two disagree — so the
 * tests here are mostly about not losing any part of the answer.
 */

const RECEIPT = movementFixture({
  movementType: 'RECEIPT',
  quantityDelta: 10,
  quantityBefore: 0,
});

const SALE = movementFixture({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e02',
  movementType: 'ISSUE',
  quantityDelta: -2,
  quantityBefore: 10,
  reasonCode: 'SOLD',
  variant: { productName: 'Lwil', sku: 'EKN-Z9Y8X7W6' },
});

describe('what a movement record says', () => {
  it('shows what changed, and what the shelf held on either side of it', async () => {
    // The delta says what changed; the pair says what somebody reconstructing a
    // discrepancy actually needs. Both come from the ledger row — neither is
    // recomputed here, because the arithmetic was settled when it was posted.
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) });

    const record = movementRecord('Diri');
    expect(within(record).getByText('+10')).toBeInTheDocument();
    expect(within(record).getByText('0 → 10')).toBeInTheDocument();
  });

  it('uses a real minus sign for stock that left', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([SALE])) });

    expect(within(movementRecord('Lwil')).getByText('−2')).toBeInTheDocument();
    expect(within(movementRecord('Lwil')).getByText('10 → 8')).toBeInTheDocument();
  });

  it('leads a sale with its reason rather than with its mechanism', async () => {
    // Sold, broken and taken for the shop's own use are three different things,
    // and a feed that called all three "stock removed" would hide exactly the
    // distinction the ledger keeps a reason column for.
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([SALE])) });

    const record = movementRecord('Lwil');
    expect(within(record).getByText(ht['reason.sold'])).toBeInTheDocument();
    expect(within(record).queryByText(ht['movement.issue'])).toBeNull();
  });

  it('does not say a sale twice', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([SALE])) });

    expect(within(movementRecord('Lwil')).getAllByText(ht['reason.sold'])).toHaveLength(1);
  });

  it('leads everything else with its type, and says the reason beside it', async () => {
    const adjustment = movementFixture({
      movementType: 'ADJUSTMENT_OUT' as never,
      quantityDelta: -1,
      quantityBefore: 8,
      reasonCode: 'DATA_ENTRY_ERROR',
    });
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([adjustment])) });

    const record = movementRecord('Diri');
    expect(within(record).getByText(ht['movement.adjustmentOut'])).toBeInTheDocument();
    expect(within(record).getByText(ht['reason.dataEntryError'])).toBeInTheDocument();
  });

  it('names the item, the shelf, the time and the person', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) });

    const record = movementRecord('Diri');
    expect(within(record).getByText(/EKN-AB12CD34/)).toBeInTheDocument();
    expect(within(record).getByText(/Main Store/)).toBeInTheDocument();
    expect(within(record).getByText('Marie Joseph')).toBeInTheDocument();
  });

  it('says so plainly when the ledger no longer knows who acted', async () => {
    // A deleted account leaves a movement behind. A blank where a name goes
    // reads as a rendering bug rather than as a fact about the record.
    await openHistory({
      [MOVEMENTS_ROUTE]: json(page([movementFixture({ actorName: null })])),
    });

    expect(
      within(movementRecord('Diri')).getByText(ht['history.unknownActor']),
    ).toBeInTheDocument();
  });

  it('shows a note somebody wrote at the counter', async () => {
    await openHistory({
      [MOVEMENTS_ROUTE]: json(page([movementFixture({ note: 'Bwat la te mouye' })])),
    });

    expect(within(movementRecord('Diri')).getByText('Bwat la te mouye')).toBeInTheDocument();
  });

  it('shows no id a person cannot use', async () => {
    // A movement id and an operation id belong in a support conversation, not
    // in a feed somebody scans.
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) });

    expect(screen.queryByText(RECEIPT.id)).toBeNull();
    expect(screen.queryByText(RECEIPT.operationId)).toBeNull();
    expect(screen.queryByText(RECEIPT.variant.id)).toBeNull();
  });
});

describe('the relationships between movements', () => {
  it('marks a movement that was undone, so nobody keeps looking for the stock', async () => {
    // Somebody scrolling past a receipt of 10 would otherwise read it as stock
    // the shop received and go looking for where it went.
    await openHistory({
      [MOVEMENTS_ROUTE]: json(
        page([
          movementFixture({
            reversedByMovementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e09',
          }),
        ]),
      ),
    });

    expect(within(movementRecord('Diri')).getByText(ht['history.wasReversed'])).toBeInTheDocument();
  });

  it('marks the reversal itself', async () => {
    await openHistory({
      [MOVEMENTS_ROUTE]: json(
        page([
          movementFixture({
            movementType: 'REVERSAL',
            quantityDelta: -10,
            quantityBefore: 10,
            reversesMovementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01',
          }),
        ]),
      ),
    });

    expect(within(movementRecord('Diri')).getByText(ht['history.isReversal'])).toBeInTheDocument();
  });

  it('marks a movement that came from a count', async () => {
    // This is what turns a reconciliation from an unexplained stock change into
    // evidence: the count says what was expected and seen, the movement says
    // what the shop did about it.
    await openHistory({
      [MOVEMENTS_ROUTE]: json(
        page([
          movementFixture({
            movementType: 'COUNT_RECONCILIATION',
            quantityDelta: -1,
            quantityBefore: 7,
            reasonCode: 'SHRINKAGE',
            countId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c11',
          }),
        ]),
      ),
    });

    const record = movementRecord('Diri');
    expect(within(record).getByText(ht['history.fromCount'])).toBeInTheDocument();
    expect(within(record).getByText(ht['movement.countReconciliation'])).toBeInTheDocument();
  });

  it('marks nothing on an ordinary movement', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) });

    const record = movementRecord('Diri');
    expect(within(record).queryByText(ht['history.wasReversed'])).toBeNull();
    expect(within(record).queryByText(ht['history.isReversal'])).toBeNull();
    expect(within(record).queryByText(ht['history.fromCount'])).toBeNull();
  });
});

describe('an empty feed', () => {
  it('says nothing matches rather than showing an empty box', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([])) });

    expect(screen.getByText(ht['history.empty'])).toBeInTheDocument();
  });
});

describe('narrowing the ledger', () => {
  it('filters by item, by name, and never shows an id', async () => {
    // The API filters by uuid — nobody at a counter can be asked to type one.
    const variantId = balanceFixture({ locations: [{ quantity: 7 }] }).variantId;
    const { api } = await openHistory({
      [MOVEMENTS_ROUTE]: json(page([RECEIPT, SALE])),
      [movementsRoute(`variantId=${variantId}`)]: json(page([RECEIPT])),
    });

    const select = screen.getByLabelText(ht['history.filterItem']) as HTMLSelectElement;
    // The choice reads as merchandise; the uuid is the value behind it.
    expect(select.textContent).not.toContain(variantId);
    fireEvent.change(select, { target: { value: variantId } });
    await settle();

    expect(api.to(movementsRoute(`variantId=${variantId}`)).length).toBeGreaterThan(0);
  });

  it('filters by shelf', async () => {
    const locationId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
    const { api } = await openHistory({
      [MOVEMENTS_ROUTE]: json(page([RECEIPT])),
      [movementsRoute(`locationId=${locationId}`)]: json(page([RECEIPT])),
    });

    fireEvent.change(screen.getByLabelText(ht['history.filterLocation']), {
      target: { value: locationId },
    });
    await settle();

    expect(api.to(movementsRoute(`locationId=${locationId}`)).length).toBeGreaterThan(0);
  });

  it('offers the whole movement vocabulary, not whatever the last page contained', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) });

    const select = screen.getByLabelText(ht['history.filterType']) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      ht['history.filterAllTypes'],
      ht['movement.receipt'],
      ht['movement.issue'],
      ht['movement.adjustmentIn'],
      ht['movement.adjustmentOut'],
      ht['movement.countReconciliation'],
      ht['movement.reversal'],
    ]);
  });

  it('sends the movement type as its stored code', async () => {
    const { api } = await openHistory({
      [MOVEMENTS_ROUTE]: json(page([RECEIPT])),
      [movementsRoute('movementType=RECEIPT')]: json(page([RECEIPT])),
    });

    fireEvent.change(screen.getByLabelText(ht['history.filterType']), {
      target: { value: 'RECEIPT' },
    });
    await settle();

    expect(api.to(movementsRoute('movementType=RECEIPT')).length).toBeGreaterThan(0);
  });

  it('offers no date range, which is the fourth filter nobody needed', async () => {
    // The feed is newest-first, and "what happened Tuesday" is a scroll. Two
    // more controls between somebody and the row they want is the cost.
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) });

    expect(screen.queryByLabelText(/recordedFrom/i)).toBeNull();
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(0);
  });

  it('offers only shelves that exist, once each', async () => {
    // The balance response repeats the same locations under every variant,
    // which is right for a grid and wrong for a picker.
    await openHistory({
      [BALANCES_ROUTE]: json([
        balanceFixture({ locations: [{ quantity: 1 }, { quantity: 2 }] }),
        balanceFixture({
          productId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a04',
          productName: 'Lwil',
          sku: 'EKN-Z9Y8X7W6',
          locations: [{ quantity: 3 }, { quantity: 4 }],
        }),
      ]),
      [MOVEMENTS_ROUTE]: json(page([RECEIPT])),
    });

    const select = screen.getByLabelText(ht['history.filterLocation']) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      ht['history.filterAllLocations'],
      'Main Store',
      'Location 2',
    ]);
  });
});

describe('reading more of the ledger', () => {
  it('appends the next page rather than replacing what is on screen', async () => {
    // Keyset pagination, never page numbers: the ledger grows at the front, so
    // page four means something different every time a receipt is booked in.
    const { api } = await openHistory({
      [MOVEMENTS_ROUTE]: json(page([RECEIPT], 'cursor-2')),
      [movementsRoute('cursor=cursor-2')]: json(page([SALE])),
    });

    fireEvent.click(screen.getByRole('button', { name: ht['history.loadMore'] }));
    await settle();

    expect(screen.getByText('Diri')).toBeInTheDocument();
    expect(screen.getByText('Lwil')).toBeInTheDocument();
    expect(api.to(movementsRoute('cursor=cursor-2'))).toHaveLength(1);
  });

  it('stops offering more at the end of the feed', async () => {
    await openHistory({
      [MOVEMENTS_ROUTE]: json(page([RECEIPT], 'cursor-2')),
      [movementsRoute('cursor=cursor-2')]: json(page([SALE])),
    });

    fireEvent.click(screen.getByRole('button', { name: ht['history.loadMore'] }));
    await settle();

    expect(screen.queryByRole('button', { name: ht['history.loadMore'] })).toBeNull();
  });

  it('offers no more when the first page is the last one', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) });

    expect(screen.queryByRole('button', { name: ht['history.loadMore'] })).toBeNull();
  });

  it('starts over when the question changes', async () => {
    // Concatenating rows from two different filters would be a feed that is
    // true of neither.
    const variantId = balanceFixture({ locations: [{ quantity: 7 }] }).variantId;
    await openHistory({
      [MOVEMENTS_ROUTE]: json(page([RECEIPT], 'cursor-2')),
      [movementsRoute('cursor=cursor-2')]: json(page([SALE])),
      [movementsRoute(`variantId=${variantId}`)]: json(page([RECEIPT])),
    });

    fireEvent.click(screen.getByRole('button', { name: ht['history.loadMore'] }));
    await settle();
    expect(screen.getByText('Lwil')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(ht['history.filterItem']), {
      target: { value: variantId },
    });
    await settle();

    expect(screen.queryByText('Lwil')).toBeNull();
  });

  it('keeps the feed readable when a further page fails', async () => {
    // A failed page is not worth an error banner over a feed somebody can
    // already read. The button stays, and pressing it again is the retry.
    await openHistory({
      [MOVEMENTS_ROUTE]: json(page([RECEIPT], 'cursor-2')),
      [movementsRoute('cursor=cursor-2')]: json({}, 500),
    });

    fireEvent.click(screen.getByRole('button', { name: ht['history.loadMore'] }));
    await settle();

    expect(screen.getByText('Diri')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['history.loadMore'] })).toBeInTheDocument();
  });
});

describe('who is offered the correction', () => {
  it('shows a reader the evidence and no way to write to it', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) });

    expect(screen.getByText('Diri')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ht['history.reverse'] })).toBeNull();
  });

  it('offers it to somebody who holds inventory.reverse', async () => {
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) }, { capabilities: REVERSER });

    expect(screen.getByRole('button', { name: ht['history.reverse'] })).toBeInTheDocument();
  });

  it('does not offer to reverse a reversal', async () => {
    // The ledger's own rule (INV-2). The server refuses with a 409, and drawing
    // a button that can only be refused is worse than drawing none.
    await openHistory(
      {
        [MOVEMENTS_ROUTE]: json(
          page([
            movementFixture({
              movementType: 'REVERSAL',
              quantityDelta: -10,
              quantityBefore: 10,
              reversesMovementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01',
            }),
          ]),
        ),
      },
      { capabilities: REVERSER },
    );

    expect(screen.queryByRole('button', { name: ht['history.reverse'] })).toBeNull();
  });

  it('does not offer to reverse something already reversed', async () => {
    await openHistory(
      {
        [MOVEMENTS_ROUTE]: json(
          page([movementFixture({ reversedByMovementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e09' })]),
        ),
      },
      { capabilities: REVERSER },
    );

    expect(screen.queryByRole('button', { name: ht['history.reverse'] })).toBeNull();
  });

  it('still offers to reverse a receipt the shelf may not be able to give back', async () => {
    // Whether reversing would take the shelf below zero depends on the current
    // balance, which this screen does not have and must not guess at. That
    // refusal belongs to the server, and hiding the button would be the browser
    // pretending to know the answer.
    await openHistory({ [MOVEMENTS_ROUTE]: json(page([RECEIPT])) }, { capabilities: REVERSER });

    expect(screen.getByRole('button', { name: ht['history.reverse'] })).toBeInTheDocument();
  });
});
