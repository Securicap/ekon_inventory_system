import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { json, mockApi } from '../helpers/fetchMock.js';
import {
  balanceFixture,
  countFixture,
  movementFixture,
  page,
  productFixture,
  userFixture,
  userResponse,
} from '../helpers/fixtures.js';
import { renderApp, settle } from '../helpers/renderApp.js';
import { viewport, type Viewport } from '../helpers/viewport.js';

/**
 * The same answers at three widths.
 *
 * Ekon is used on a phone at a counter, on a tablet in a back room, and on a
 * laptop in an office, and the rule across all three is that **nothing scrolls
 * sideways**. The stock register earns a real table on a desktop and becomes a
 * list of records on a phone; the two PR 7 screens never become tables at all,
 * because a movement is six facts that belong together and six columns on a
 * 390px screen is either a sideways scroll or six illegible columns.
 *
 * Reached through the real shell at every width — including the More sheet on a
 * phone, since neither Counts nor History is one of the three everyday
 * destinations the bottom bar carries.
 */

const CAPABILITIES = ['inventory.read', 'inventory.count', 'catalog.read'] as const;

const ROUTES = {
  'GET /api/inventory/balances': json([balanceFixture({ locations: [{ quantity: 7 }] })]),
  'GET /api/inventory/counts?status=OPEN': json(
    page([countFixture({ expectedQuantity: 7, countedQuantity: 6 })]),
  ),
  'GET /api/inventory/movements?': json(
    page([movementFixture({ quantityDelta: 10, quantityBefore: 0 })]),
  ),
  'GET /api/catalog/products': json([productFixture()]),
};

/**
 * Opens one destination at one width, through whichever chrome that width has.
 *
 * The phone route is the interesting one: the bottom bar carries three everyday
 * acts and everything else lives behind More, so a test that reached past the
 * sheet would be proving a screen nobody on a phone can get to.
 */
async function open(size: Viewport, label: string): Promise<void> {
  viewport(size);
  mockApi({
    'GET /api/auth/me': json(userResponse(userFixture({ capabilities: [...CAPABILITIES] }))),
    ...ROUTES,
  });
  renderApp();
  await screen.findByRole('navigation');

  const direct = screen.queryByRole('button', { name: label });
  if (direct) {
    fireEvent.click(direct);
  } else {
    // Behind More on a phone, behind the rail's own opener on a tablet.
    const opener =
      screen.queryByRole('button', { name: ht['nav.more'] }) ??
      screen.getByRole('button', { name: ht['nav.openNavigation'] });
    fireEvent.click(opener);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label }));
  }
  await settle();
}

describe.each(['mobile', 'tablet', 'desktop'] as const)('at %s width', (size) => {
  it('reads a count with all three numbers on it', async () => {
    await open(size, ht['nav.counts']);

    const record = screen.getByText('Diri').closest('li') as HTMLElement;
    expect(within(record).getByText('7')).toBeInTheDocument();
    expect(within(record).getByText('6')).toBeInTheDocument();
    expect(within(record).getByText('−1')).toBeInTheDocument();
    cleanup();
  });

  it('reads a movement with its before and after on it', async () => {
    await open(size, ht['nav.history']);

    const record = screen.getByText('Diri').closest('li') as HTMLElement;
    expect(within(record).getByText('+10')).toBeInTheDocument();
    expect(within(record).getByText('0 → 10')).toBeInTheDocument();
    cleanup();
  });

  it('makes neither of them a table, at any width', async () => {
    // A movement is six facts that belong together. The record stays a record
    // and the columns become rows as the screen narrows — there is no width at
    // which this turns into something that scrolls sideways.
    await open(size, ht['nav.history']);
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();

    await open(size, ht['nav.counts']);
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();
  });

  it('keeps Products a set of merchandise cards rather than a register', async () => {
    // Products carries brand, classification, variants and prices. None of that
    // fits a row, and none of it is a quantity.
    await open(size, ht['nav.products']);

    expect(screen.getByRole('heading', { name: 'Diri' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();
  });

  it('gives the stock register the presentation the width can carry', async () => {
    // The one screen that does change shape: a real table where there is room,
    // a list of records on a phone. Both say the same thing.
    await open(size, ht['nav.stock']);

    if (size === 'mobile') {
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.getByRole('heading', { level: 2, name: 'Diri' })).toBeInTheDocument();
    } else {
      expect(screen.getByRole('table')).toBeInTheDocument();
    }
    cleanup();
  });
});

describe('every control a thumb has to hit', () => {
  it('is a real button rather than a clickable region', async () => {
    // A `div` with a click handler is not reachable by keyboard, is not
    // announced as a control, and has no focus ring. On the two screens PR 7
    // added there are none.
    await open('mobile', ht['nav.counts']);

    const clickable = [...document.querySelectorAll('[onclick], div[role="button"]')];
    expect(clickable).toEqual([]);
  });
});
