import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, offline } from '../helpers/fetchMock.js';
import { balanceFixture, page } from '../helpers/fixtures.js';
import { BALANCES_ROUTE, openStock, stockRecord } from '../helpers/stock.js';
import { settle } from '../helpers/renderApp.js';

/**
 * What somebody can do about one line of stock, offered on that line.
 *
 * Adjusting, counting and reading a movement's history are **contextual
 * actions**, not destinations. None of them is a place somebody goes: each
 * belongs to the row whose number is in question, which is the whole reason
 * `inventory.adjust` opens no door in the sidebar.
 */

const ADJUST_ROUTE = 'POST /api/inventory/adjust';
const MOVEMENTS_ROUTE = 'GET /api/inventory/movements?';

const STOCKED = balanceFixture({ locations: [{ quantity: 7 }] });

/** What the adjust route answers: the ordinary movement result. */
const ADJUSTED = {
  operationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4907',
  movementId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e21',
  quantityAfter: 6,
};

const READER = ['inventory.read'] as const;
const ADJUSTER = ['inventory.read', 'inventory.adjust'] as const;
const COUNTER = ['inventory.read', 'inventory.count'] as const;

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

/**
 * One of the row's own controls.
 *
 * Scoped to the stock record rather than to the page, because two of the three
 * share their name with a sidebar destination — *History* and *Count* are a
 * door and a row action, and they are the same word in the shop's language. A
 * bare page query would find the door.
 */
function rowAction(label: string): HTMLButtonElement {
  return within(stockRecord('Diri')).getByRole('button', { name: label }) as HTMLButtonElement;
}

function noRowAction(label: string): boolean {
  return within(stockRecord('Diri')).queryByRole('button', { name: label }) === null;
}

function confirm(): void {
  const buttons = within(dialog()).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1]!);
}

async function openAdjust(
  routes: Record<string, ReturnType<typeof json>> = {},
): Promise<Awaited<ReturnType<typeof openStock>>> {
  const opened = await openStock(
    { [BALANCES_ROUTE]: json([STOCKED]), ...routes },
    { capabilities: ADJUSTER },
  );
  const opener = rowAction(ht['stock.actionAdjust']);
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole('dialog');
  return opened;
}

describe('what a row offers', () => {
  it('offers history to anybody who may read stock', async () => {
    // Reaching this SKU's own history is the thing that is awkward from a
    // destination, which is exactly what a row shortcut is good for.
    await openStock({ [BALANCES_ROUTE]: json([STOCKED]) }, { capabilities: READER });

    expect(rowAction(ht['stock.actionHistory'])).toBeInTheDocument();
  });

  it('offers counting only to somebody who may count', async () => {
    await openStock({ [BALANCES_ROUTE]: json([STOCKED]) }, { capabilities: READER });
    expect(noRowAction(ht['stock.actionCount'])).toBe(true);
  });

  it('offers correcting only to somebody who may adjust', async () => {
    // An action somebody may not perform is absent rather than disabled: a
    // greyed-out button is a door with a lock on it.
    await openStock({ [BALANCES_ROUTE]: json([STOCKED]) }, { capabilities: COUNTER });

    expect(rowAction(ht['stock.actionCount'])).toBeInTheDocument();
    expect(noRowAction(ht['stock.actionAdjust'])).toBe(true);
  });

  it('offers neither Receive nor Remove on a row', async () => {
    // Both have their own destination, both are everyday work with their own
    // form, and duplicating them onto every row would give one act two front
    // doors that behave differently.
    await openStock(
      { [BALANCES_ROUTE]: json([STOCKED]) },
      { capabilities: ['inventory.read', 'inventory.receive', 'inventory.remove'] },
    );

    const record = stockRecord('Diri');
    expect(within(record).queryByRole('button', { name: ht['nav.receive'] })).toBeNull();
    expect(within(record).queryByRole('button', { name: ht['nav.remove'] })).toBeNull();
  });

  it('offers no count or correction for merchandise with no shelf', async () => {
    // A variant held nowhere has nothing for a per-location command to be
    // about. Its history is still worth reaching.
    await openStock(
      { [BALANCES_ROUTE]: json([balanceFixture({ locations: [] })]) },
      { capabilities: ['inventory.read', 'inventory.count', 'inventory.adjust'] },
    );

    expect(rowAction(ht['stock.actionHistory'])).toBeInTheDocument();
    expect(noRowAction(ht['stock.actionCount'])).toBe(true);
    expect(noRowAction(ht['stock.actionAdjust'])).toBe(true);
  });
});

describe('where a row action leads', () => {
  it('opens history already narrowed to that item', async () => {
    const { api } = await openStock(
      {
        [BALANCES_ROUTE]: json([STOCKED]),
        [`GET /api/inventory/movements?variantId=${STOCKED.variantId}`]: json(page([])),
      },
      { capabilities: READER },
    );

    fireEvent.click(rowAction(ht['stock.actionHistory']));
    await screen.findByRole('heading', { name: ht['history.title'] });
    await settle();

    expect(
      api.to(`GET /api/inventory/movements?variantId=${STOCKED.variantId}`).length,
    ).toBeGreaterThan(0);
    // And not the unfiltered feed: arriving from a row means "this item".
    expect(api.to(MOVEMENTS_ROUTE)).toHaveLength(0);
  });

  it('opens the count form with the item and the shelf already chosen', async () => {
    await openStock(
      {
        [BALANCES_ROUTE]: json([STOCKED]),
        'GET /api/inventory/counts?status=OPEN': json(page([])),
      },
      { capabilities: COUNTER },
    );

    fireEvent.click(rowAction(ht['stock.actionCount']));
    await screen.findByRole('heading', { name: ht['counts.title'] });
    await settle();

    expect((screen.getByLabelText(ht['counts.item']) as HTMLSelectElement).value).toBe(
      STOCKED.variantId,
    );
    expect((screen.getByLabelText(ht['counts.location']) as HTMLSelectElement).value).toBe(
      STOCKED.locations[0]!.locationId,
    );
  });

  it('opens correcting as a dialog on the row, not as a destination', async () => {
    // Adjusting is not a place. The stock screen stays underneath it.
    await openAdjust();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: ht['stock.title'] })).toBeInTheDocument();
  });
});

describe('what the correction dialog says', () => {
  it('says what an adjustment is for, and what it is not for', async () => {
    // Removing records that units left the shelf; adjusting records that
    // nothing happened and the number was wrong. They move the same stock and
    // mean opposite things in a history, permanently.
    await openAdjust();

    expect(within(dialog()).getByText(ht['adjust.explains'])).toBeInTheDocument();
  });

  it('shows what Ekon currently records for that shelf', async () => {
    await openAdjust();

    const body = dialog();
    expect(within(body).getByText(ht['adjust.recorded'])).toBeInTheDocument();
    expect(within(body).getByText('7')).toBeInTheDocument();
  });

  it('asks which way and how many, and never asks for a minus sign', async () => {
    // Somebody at a counter should not have to know that a minus sign is how
    // you say "we have fewer than it says".
    await openAdjust();

    const direction = within(dialog()).getByLabelText(ht['adjust.direction']) as HTMLSelectElement;
    expect([...direction.options].map((option) => option.textContent)).toEqual([
      ht['adjust.directionIncrease'],
      ht['adjust.directionDecrease'],
    ]);
    expect((within(dialog()).getByLabelText(ht['adjust.quantity']) as HTMLInputElement).min).toBe(
      '1',
    );
  });

  it('says what will be sent before anybody agrees to it', async () => {
    // The translation from "fewer by three" to −3 happens in front of the
    // person rather than behind them.
    await openAdjust();

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '3' },
    });
    await settle();

    expect(
      within(dialog()).getByText(ht['adjust.willApply'].replace('{delta}', '−3')),
    ).toBeInTheDocument();
  });

  it('flips the sentence with the direction', async () => {
    await openAdjust();

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '3' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.direction']), {
      target: { value: 'increase' },
    });
    await settle();

    expect(
      within(dialog()).getByText(ht['adjust.willApply'].replace('{delta}', '+3')),
    ).toBeInTheDocument();
  });

  it('lets the shelf be changed, because the row is a starting point', async () => {
    // The number that is wrong may be the back room's rather than the
    // counter's.
    await openStock(
      {
        [BALANCES_ROUTE]: json([balanceFixture({ locations: [{ quantity: 7 }, { quantity: 2 }] })]),
      },
      { capabilities: ADJUSTER },
    );
    fireEvent.click(rowAction(ht['stock.actionAdjust']));
    await screen.findByRole('dialog');

    const shelf = within(dialog()).getByLabelText(ht['counts.location']) as HTMLSelectElement;
    expect([...shelf.options].map((option) => option.textContent)).toEqual([
      'Main Store',
      'Location 2',
    ]);
  });
});

describe('what the correction sends', () => {
  it('turns a direction and a magnitude into a signed delta', async () => {
    const { api } = await openAdjust({ [ADJUST_ROUTE]: json(ADJUSTED) });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '1' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'DATA_ENTRY_ERROR' },
    });
    confirm();
    await settle();

    expect(api.to(ADJUST_ROUTE)[0]?.body).toMatchObject({
      quantityDelta: -1,
      reason: 'DATA_ENTRY_ERROR',
      variantId: STOCKED.variantId,
    });
  });

  it('sends a positive delta for an increase', async () => {
    const { api } = await openAdjust({ [ADJUST_ROUTE]: json(ADJUSTED) });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.direction']), {
      target: { value: 'increase' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '4' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'MISSED_MOVEMENT' },
    });
    confirm();
    await settle();

    expect(api.to(ADJUST_ROUTE)[0]?.body).toMatchObject({ quantityDelta: 4 });
  });

  it('requires a reason', async () => {
    // A stock change nobody explained is what the whole ledger exists to
    // prevent.
    const { api } = await openAdjust({ [ADJUST_ROUTE]: json(ADJUSTED) });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '1' },
    });
    confirm();
    await settle();

    expect(within(dialog()).getByText(ht['adjust.reasonRequired'])).toBeInTheDocument();
    expect(api.to(ADJUST_ROUTE)).toHaveLength(0);
  });

  it('demands a note for OTHER', async () => {
    const { api } = await openAdjust({ [ADJUST_ROUTE]: json(ADJUSTED) });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '1' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'OTHER' },
    });
    confirm();
    await settle();

    expect(within(dialog()).getByText(ht['adjust.noteRequired'])).toBeInTheDocument();
    expect(api.to(ADJUST_ROUTE)).toHaveLength(0);
  });

  it('refuses a correction by nothing', async () => {
    // "Correct it by zero" is an unfinished form, not a command worth sending.
    const { api } = await openAdjust({ [ADJUST_ROUTE]: json(ADJUSTED) });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '0' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'DATA_ENTRY_ERROR' },
    });
    confirm();
    await settle();

    expect(within(dialog()).getByText(ht['adjust.quantityInvalid'])).toBeInTheDocument();
    expect(api.to(ADJUST_ROUTE)).toHaveLength(0);
  });

  it('keeps one operation id across a retry', async () => {
    const { api } = await openAdjust({
      [ADJUST_ROUTE]: [offline(), json(ADJUSTED)] as never,
    });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '1' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'DATA_ENTRY_ERROR' },
    });
    confirm();
    await settle();
    confirm();
    await settle();

    const bodies = api.to(ADJUST_ROUTE).map((request) => request.body as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.operationId).toBe(bodies[1]!.operationId);
  });

  it('does not send twice while the correction is in flight', async () => {
    const pending = deferred();
    const { api } = await openAdjust({
      [ADJUST_ROUTE]: pending.responder as ReturnType<typeof json>,
    });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '1' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'DATA_ENTRY_ERROR' },
    });
    confirm();
    await settle();
    confirm();
    await settle();

    expect(api.to(ADJUST_ROUTE)).toHaveLength(1);
    pending.resolve(json(ADJUSTED));
    await settle();
  });
});

describe('after a correction', () => {
  it('re-reads the shelf, and leaves the counts alone', async () => {
    // A correction is a movement, so the shelf and the ledger both changed. It
    // observes nothing and settles nothing, so a count recorded this morning
    // still says what it said.
    const { api } = await openAdjust({ [ADJUST_ROUTE]: json(ADJUSTED) });

    const balancesBefore = api.to(BALANCES_ROUTE).length;
    const countsBefore = api.requests.filter((request) =>
      request.url.startsWith('/api/inventory/counts'),
    ).length;

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '1' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'DATA_ENTRY_ERROR' },
    });
    confirm();
    await settle();

    expect(api.to(BALANCES_ROUTE).length).toBeGreaterThan(balancesBefore);
    expect(
      api.requests.filter((request) => request.url.startsWith('/api/inventory/counts')).length,
    ).toBe(countsBefore);
  });

  it('closes the dialog', async () => {
    await openAdjust({ [ADJUST_ROUTE]: json(ADJUSTED) });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '1' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'DATA_ENTRY_ERROR' },
    });
    confirm();
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('when the shelf cannot absorb the correction', () => {
  it('says so, rather than having predicted it', async () => {
    // The stock floor depends on a balance this dialog does not hold and must
    // not guess at. The refusal belongs to the server, and it is rendered as
    // itself.
    await openAdjust({
      [ADJUST_ROUTE]: apiFailure('INSUFFICIENT_STOCK', 409) as ReturnType<typeof json>,
    });

    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.quantity']), {
      target: { value: '99' },
    });
    fireEvent.change(within(dialog()).getByLabelText(ht['adjust.reason']), {
      target: { value: 'DATA_ENTRY_ERROR' },
    });
    confirm();
    await settle();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

describe('the dialog itself', () => {
  it('closes on Escape without correcting anything', async () => {
    const { api } = await openAdjust();

    fireEvent.keyDown(dialog(), { key: 'Escape' });
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.to(ADJUST_ROUTE)).toHaveLength(0);
  });

  it('returns focus to the row control that opened it', async () => {
    await openAdjust();

    fireEvent.click(within(dialog()).getByRole('button', { name: ht['action.cancel'] }));
    await settle();

    expect(rowAction(ht['stock.actionAdjust'])).toHaveFocus();
  });
});
