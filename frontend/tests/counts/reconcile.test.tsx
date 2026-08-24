import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, offline } from '../helpers/fetchMock.js';
import { countFixture, page } from '../helpers/fixtures.js';
import {
  ALL_COUNTS_ROUTE,
  BALANCES_ROUTE,
  COUNTER,
  OPEN_COUNTS_ROUTE,
  openCounts,
  reconcileRoute,
} from '../helpers/counts.js';
import { settle } from '../helpers/renderApp.js';

/**
 * Accepting a difference: the one act on the Counts screen that changes stock.
 *
 * The sentence this dialog says is the most carefully worded string in the
 * application, and the first test here is the reason this file exists.
 */

const SHORT = countFixture({ expectedQuantity: 7, countedQuantity: 6 });
const OVER = countFixture({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c22',
  expectedQuantity: 4,
  countedQuantity: 6,
});

const RECONCILE_SHORT = reconcileRoute(SHORT.id);

async function openReconcile(
  count = SHORT,
  routes: Record<string, ReturnType<typeof json>> = {},
): Promise<Awaited<ReturnType<typeof openCounts>>> {
  const opened = await openCounts(
    { [OPEN_COUNTS_ROUTE]: json(page([count])), ...routes },
    { capabilities: COUNTER },
  );
  const opener = screen.getByRole('button', { name: ht['counts.reconcile'] });
  // Focused before it is pressed, which is what a real pointer or a real Tab
  // does and what jsdom's synthetic click does not — the dialog remembers what
  // opened it so it can hand focus back, and there would be nothing to remember.
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole('dialog');
  return opened;
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

function chooseReason(reason: string): void {
  fireEvent.change(within(dialog()).getByLabelText(ht['counts.reason']), {
    target: { value: reason },
  });
}

/**
 * The dialog's confirm control, found by position rather than by its label —
 * the label becomes "sending" while the decision is in flight, and the test
 * that presses it twice is exactly the one that needs to find it then.
 */
function confirmButton(): HTMLButtonElement {
  const buttons = within(dialog()).getAllByRole('button');
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

function confirm(): void {
  fireEvent.click(confirmButton());
}

describe('the sentence', () => {
  it('names the change, and never the destination', async () => {
    // > This will adjust inventory by −1.
    //
    // and never:
    //
    // > This will set inventory to 6.
    //
    // The second is what a reader assumes and it is wrong: six was true when
    // the shelf was walked, and if a unit sold in the hour since, accepting a
    // difference of one leaves four. The server applies the *difference* to the
    // current balance, and a dialog that promised a destination would be
    // promising a number the system will not produce.
    await openReconcile(SHORT);

    expect(
      within(dialog()).getByText(ht['counts.willDecrease'].replace('{delta}', '−1')),
    ).toBeInTheDocument();
  });

  it('says the same about a surplus, as a change upward', async () => {
    await openReconcile(OVER);

    expect(
      within(dialog()).getByText(ht['counts.willIncrease'].replace('{delta}', '+2')),
    ).toBeInTheDocument();
  });

  it('never says the words that would promise a destination', async () => {
    // A regression guard with teeth: the counted quantity appears in the dialog
    // as evidence, but no sentence may present it as where stock will land.
    await openReconcile(SHORT);

    const body = dialog().textContent ?? '';
    for (const forbidden of ['set inventory', 'mete stòk la nan', 'définir', 'set to']) {
      expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('says the count itself stays as it is', async () => {
    // Reconciliation appends a movement; it does not rewrite the observation.
    await openReconcile(SHORT);

    expect(within(dialog()).getByText(ht['counts.reconcileExplains'])).toBeInTheDocument();
  });

  it('shows the evidence the decision rests on', async () => {
    await openReconcile(SHORT);

    const body = dialog();
    expect(within(body).getByText(ht['counts.expected'])).toBeInTheDocument();
    expect(within(body).getByText('7')).toBeInTheDocument();
    expect(within(body).getByText('6')).toBeInTheDocument();
    expect(within(body).getByText('Main Store')).toBeInTheDocument();
  });
});

describe('the reason', () => {
  it('is required, because a stock change nobody explained is the thing this prevents', async () => {
    const { api } = await openReconcile(SHORT);

    confirm();
    await settle();

    expect(within(dialog()).getByText(ht['counts.reasonRequired'])).toBeInTheDocument();
    expect(api.to(RECONCILE_SHORT)).toHaveLength(0);
  });

  it('offers the seven conclusions an investigation can reach, and no eighth', async () => {
    // There is deliberately no "the count was wrong": a mistaken count is
    // corrected by counting again, not by accepting a difference nobody
    // believes in.
    await openReconcile(SHORT);

    const select = within(dialog()).getByLabelText(ht['counts.reason']) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      ht['counts.choose'],
      ht['reason.unrecordedSale'],
      ht['reason.missedReceipt'],
      ht['reason.damaged'],
      ht['reason.misplacedStock'],
      ht['reason.shrinkage'],
      ht['reason.dataEntryError'],
      ht['reason.other'],
    ]);
  });

  it('demands a note for OTHER, which explains nothing on its own', async () => {
    const { api } = await openReconcile(SHORT);

    chooseReason('OTHER');
    confirm();
    await settle();

    expect(within(dialog()).getByText(ht['counts.noteRequired'])).toBeInTheDocument();
    expect(api.to(RECONCILE_SHORT)).toHaveLength(0);
  });

  it('accepts OTHER once somebody has written what they found', async () => {
    const { api } = await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: json(
        countFixture({ expectedQuantity: 7, countedQuantity: 6, reconciliation: {} }),
      ),
    });

    chooseReason('OTHER');
    fireEvent.change(within(dialog()).getByLabelText(ht['counts.note']), {
      target: { value: 'Yon bwat ki tonbe dèyè etajè a' },
    });
    confirm();
    await settle();

    expect(api.to(RECONCILE_SHORT)[0]?.body).toMatchObject({
      reason: 'OTHER',
      note: 'Yon bwat ki tonbe dèyè etajè a',
    });
  });

  it('sends the code rather than the translated word', async () => {
    const { api } = await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: json(
        countFixture({ expectedQuantity: 7, countedQuantity: 6, reconciliation: {} }),
      ),
    });

    chooseReason('SHRINKAGE');
    confirm();
    await settle();

    expect(api.to(RECONCILE_SHORT)[0]?.body).toMatchObject({ reason: 'SHRINKAGE' });
  });
});

describe('what the request carries', () => {
  it('states the decision and nothing about what moves', async () => {
    // The variant, the location and the delta all come from the stored count.
    // There is nothing here for a caller to state wrongly, and the `.strict()`
    // schema refuses it if one tried.
    const { api } = await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: json(
        countFixture({ expectedQuantity: 7, countedQuantity: 6, reconciliation: {} }),
      ),
    });

    chooseReason('DAMAGED');
    confirm();
    await settle();

    const body = api.to(RECONCILE_SHORT)[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['operationId', 'reason']);
  });

  it('omits an empty note rather than sending an empty string', async () => {
    const { api } = await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: json(
        countFixture({ expectedQuantity: 7, countedQuantity: 6, reconciliation: {} }),
      ),
    });

    chooseReason('DAMAGED');
    fireEvent.change(within(dialog()).getByLabelText(ht['counts.note']), {
      target: { value: '   ' },
    });
    confirm();
    await settle();

    expect(api.to(RECONCILE_SHORT)[0]?.body).not.toHaveProperty('note');
  });

  it('keeps one operation id across a retry', async () => {
    const { api } = await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: json({}, 500),
    });

    chooseReason('DAMAGED');
    confirm();
    await settle();
    confirm();
    await settle();

    const bodies = api
      .to(RECONCILE_SHORT)
      .map((request) => request.body as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.operationId).toBe(bodies[1]!.operationId);
  });

  it('does not send twice while the decision is still in flight', async () => {
    const pending = deferred();
    const { api } = await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: pending.responder as ReturnType<typeof json>,
    });

    chooseReason('DAMAGED');
    confirm();
    await settle();
    confirm();
    await settle();

    expect(api.to(RECONCILE_SHORT)).toHaveLength(1);
    pending.resolve(
      json(countFixture({ expectedQuantity: 7, countedQuantity: 6, reconciliation: {} })),
    );
    await settle();
  });
});

describe('what a reconciliation invalidates', () => {
  it('refreshes the counts, the balances and the history', async () => {
    // The opposite of recording a count: this posted a movement, so the shelf
    // and the ledger both changed and all three feeds are now out of date.
    const { api } = await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: json(
        countFixture({ expectedQuantity: 7, countedQuantity: 6, reconciliation: {} }),
      ),
    });

    const balancesBefore = api.to(BALANCES_ROUTE).length;
    const countsBefore = api.to(OPEN_COUNTS_ROUTE).length + api.to(ALL_COUNTS_ROUTE).length;

    chooseReason('DAMAGED');
    confirm();
    await settle();

    expect(api.to(OPEN_COUNTS_ROUTE).length + api.to(ALL_COUNTS_ROUTE).length).toBeGreaterThan(
      countsBefore,
    );
    expect(api.to(BALANCES_ROUTE).length).toBeGreaterThan(balancesBefore);
  });

  it('closes the dialog once the decision is taken', async () => {
    await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: json(
        countFixture({ expectedQuantity: 7, countedQuantity: 6, reconciliation: {} }),
      ),
    });

    chooseReason('DAMAGED');
    confirm();
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('when the server refuses', () => {
  it('keeps the dialog open and says what happened', async () => {
    // A difference somebody else already accepted. Closing the dialog on a
    // failure would leave a person unsure whether the stock changed.
    await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: apiFailure('CONFLICT', 409) as ReturnType<typeof json>,
    });

    chooseReason('DAMAGED');
    confirm();
    await settle();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('says a dead network is a dead network', async () => {
    await openReconcile(SHORT, {
      [reconcileRoute(SHORT.id)]: offline() as ReturnType<typeof json>,
    });

    chooseReason('DAMAGED');
    confirm();
    await settle();

    expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

describe('the dialog itself', () => {
  it('is a modal a keyboard can use', async () => {
    await openReconcile(SHORT);

    const panel = dialog();
    expect(panel).toHaveAttribute('aria-modal', 'true');
    // Focus lands on the first control inside, not on the heading above it.
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape without changing anything', async () => {
    const { api } = await openReconcile(SHORT);

    fireEvent.keyDown(dialog(), { key: 'Escape' });
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.to(RECONCILE_SHORT)).toHaveLength(0);
  });

  it('returns focus to the control that opened it', async () => {
    await openReconcile(SHORT);

    fireEvent.click(within(dialog()).getByRole('button', { name: ht['action.cancel'] }));
    await settle();

    expect(screen.getByRole('button', { name: ht['counts.reconcile'] })).toHaveFocus();
  });
});
