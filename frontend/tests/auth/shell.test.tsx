import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi } from '../helpers/fetchMock.js';
import { locationFixture, productFixture, userFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp } from '../helpers/renderApp.js';
import { viewport, type Viewport } from '../helpers/viewport.js';

async function signedInAt(size: Viewport, capabilities: readonly Capability[]): Promise<void> {
  viewport(size);
  mockApi({
    'GET /api/auth/me': json(userResponse(userFixture({ capabilities }))),
    'GET /api/catalog/products': json([productFixture()]),
    'GET /api/inventory/locations': json([locationFixture()]),
    'GET /api/inventory/balances': json([]),
  });
  renderApp();
  await screen.findByRole('navigation');
}

const EVERYTHING: readonly Capability[] = [
  'catalog.read',
  'inventory.read',
  'inventory.receive',
  'inventory.remove',
  'identity.manage',
];

/** The labels of a group's entries, in the order the group lists them. */
function group(heading: string): string[] {
  const list = screen.getByRole('list', { name: heading });
  return within(list)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '');
}

function openPanel(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: ht['nav.more'] }));
  return screen.getByRole('dialog', { name: ht['nav.main'] });
}

/**
 * The shell in its three shapes.
 *
 * These are about one property above all: a phone and a desktop are two
 * presentations of a single answer to "what may this person open". A bottom bar
 * that could show a destination the sidebar hides, or a panel with its own idea
 * of which capability opens which door, would be a second authorization model
 * living in the browser — and the one that is wrong is always the one nobody
 * tested.
 */
describe('desktop shell', () => {
  it('groups destinations under operations and management', async () => {
    await signedInAt('desktop', EVERYTHING);

    expect(group(ht['nav.groupOperations'])).toEqual([
      ht['nav.home'],
      ht['nav.stock'],
      ht['nav.receive'],
      ht['nav.remove'],
    ]);
    expect(group(ht['nav.groupManagement'])).toEqual([ht['nav.products'], ht['nav.newUser']]);
  });

  it('drops a group heading entirely when no destination in it is permitted', async () => {
    // An employee who may not touch products or accounts is shown neither the
    // entries nor the heading over the gap they would have left.
    await signedInAt('desktop', ['inventory.read', 'inventory.receive']);

    expect(screen.getByText(ht['nav.groupOperations'])).toBeInTheDocument();
    expect(screen.queryByText(ht['nav.groupManagement'])).toBeNull();
    expect(screen.queryByRole('button', { name: ht['nav.products'] })).toBeNull();
    expect(screen.queryByRole('button', { name: ht['nav.newUser'] })).toBeNull();
  });

  it('marks the open destination and moves the screen when another is pressed', async () => {
    await signedInAt('desktop', ['inventory.read', 'catalog.read']);

    const home = screen.getByRole('button', { name: ht['nav.home'] });
    const products = screen.getByRole('button', { name: ht['nav.products'] });
    expect(home).toHaveAttribute('aria-current', 'page');

    fireEvent.click(products);
    await screen.findByText('Diri');
    expect(products).toHaveAttribute('aria-current', 'page');
    expect(home).not.toHaveAttribute('aria-current');
  });

  it('shows no navigation sheet, because every destination is already on screen', async () => {
    await signedInAt('desktop', EVERYTHING);

    expect(screen.queryByRole('button', { name: ht['nav.more'] })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('mobile shell', () => {
  it('carries only the permitted everyday destinations in the bottom bar', async () => {
    await signedInAt('mobile', EVERYTHING);

    const bar = screen.getByRole('navigation', { name: ht['nav.everyday'] });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent ?? ''),
    ).toEqual([ht['nav.stock'], ht['nav.receive'], ht['nav.remove'], ht['nav.more']]);
  });

  it('leaves out of the bottom bar what the person may not open', async () => {
    await signedInAt('mobile', ['inventory.read']);

    const bar = screen.getByRole('navigation', { name: ht['nav.everyday'] });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent ?? ''),
    ).toEqual([ht['nav.stock'], ht['nav.more']]);
  });

  it('offers the complete grouped navigation behind More', async () => {
    await signedInAt('mobile', EVERYTHING);
    const sheet = openPanel();

    // The same two groups, in the same order, as the desktop sidebar draws —
    // including the destinations the bottom bar had no room for.
    expect(group(ht['nav.groupOperations'])).toEqual([
      ht['nav.home'],
      ht['nav.stock'],
      ht['nav.receive'],
      ht['nav.remove'],
    ]);
    expect(group(ht['nav.groupManagement'])).toEqual([ht['nav.products'], ht['nav.newUser']]);
    expect(within(sheet).getByText(ht['role.OWNER'])).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
  });

  it('never offers behind More a destination the capability does not open', async () => {
    // One source of truth, asked twice: the sheet cannot be more generous than
    // the bar, because both are filtered from the same list.
    await signedInAt('mobile', ['inventory.receive']);
    const sheet = openPanel();

    expect(
      within(sheet)
        .getAllByRole('button')
        .map((button) => button.textContent ?? ''),
    ).toEqual([ht['nav.close'], ht['nav.home'], ht['nav.receive'], ht['auth.signOut']]);
  });

  it('changes the screen from the sheet and closes it', async () => {
    await signedInAt('mobile', ['inventory.read', 'catalog.read']);
    const sheet = openPanel();

    fireEvent.click(within(sheet).getByRole('button', { name: ht['nav.products'] }));
    await screen.findByText('Diri');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes focus, closes on Escape, and gives focus back to what opened it', async () => {
    await signedInAt('mobile', EVERYTHING);

    const more = screen.getByRole('button', { name: ht['nav.more'] });
    more.focus();
    fireEvent.click(more);

    const close = screen.getByRole('button', { name: ht['nav.close'] });
    expect(close).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more).toHaveFocus();
  });
});

describe('tablet shell', () => {
  it('keeps the everyday destinations in the rail and the rest one press away', async () => {
    await signedInAt('tablet', EVERYTHING);

    const rail = screen.getByRole('navigation', { name: ht['nav.everyday'] });
    expect(
      within(rail)
        .getAllByRole('button')
        .map((button) => button.textContent ?? ''),
    ).toEqual([ht['nav.stock'], ht['nav.receive'], ht['nav.remove']]);

    fireEvent.click(screen.getByRole('button', { name: ht['nav.openNavigation'] }));
    const sheet = screen.getByRole('dialog', { name: ht['nav.main'] });
    expect(within(sheet).getByRole('button', { name: ht['nav.newUser'] })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
  });
});

/**
 * The three control-and-review destinations PR 7 added, and the one property
 * that had to survive them.
 *
 * Counts and History are real places somebody goes — "what did we find on the
 * shelves" and "how did the numbers get here" are questions, not actions on a
 * row. Adjusting, reversing and withdrawing merchandise are the opposite: each
 * belongs to the thing it is about, and none of them opens a door.
 */
describe('control destinations', () => {
  it('gives reviewing its own group between doing and managing', async () => {
    // Three short lists read better than one long one, and the split is by what
    // somebody came to do: operate the shop, check it, or run it.
    await signedInAt('desktop', [...EVERYTHING]);

    expect(group(ht['nav.groupControl'])).toEqual([ht['nav.counts'], ht['nav.history']]);
  });

  it('opens both on inventory.read, because seeing is seeing', async () => {
    // Recording a count and accepting a difference need `inventory.count`, and
    // those are gated on the screen rather than at the door.
    await signedInAt('desktop', ['inventory.read']);

    expect(group(ht['nav.groupControl'])).toEqual([ht['nav.counts'], ht['nav.history']]);
  });

  it('drops the whole group for somebody who may not see stock', async () => {
    await signedInAt('desktop', ['catalog.read']);

    expect(screen.queryByText(ht['nav.groupControl'])).toBeNull();
  });

  it("keeps the phone's bottom bar at the three everyday acts", async () => {
    // The bar is bounded on purpose. Counts and History are real destinations
    // and they are behind More, because a bottom bar that grew with every new
    // screen would end up unusable at the width it exists for.
    await signedInAt('mobile', [...EVERYTHING, 'inventory.count']);

    const bar = screen.getByRole('navigation', { name: ht['nav.everyday'] });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent ?? ''),
    ).toEqual([ht['nav.stock'], ht['nav.receive'], ht['nav.remove'], ht['nav.more']]);
  });

  it('offers them behind More on a phone', async () => {
    await signedInAt('mobile', ['inventory.read']);

    const sheet = openPanel();
    expect(within(sheet).getByRole('button', { name: ht['nav.counts'] })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: ht['nav.history'] })).toBeInTheDocument();
  });

  it('opens no destination anywhere for the three contextual capabilities', async () => {
    // Adjusting belongs to the inventory row whose number is wrong, reversing
    // to a movement in History, and withdrawing merchandise to a product on
    // Products. A capability is not a destination.
    await signedInAt('mobile', ['inventory.adjust', 'inventory.reverse', 'catalog.deactivate']);

    const bar = screen.getByRole('navigation', { name: ht['nav.everyday'] });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent ?? ''),
    ).toEqual([ht['nav.more']]);

    // The sheet's own Close is not a destination; what it offers is Home and
    // the way out, and nothing else.
    const sheet = openPanel();
    expect(
      within(sheet)
        .getAllByRole('button')
        .map((button) => button.textContent ?? '')
        .filter((label) => label !== ht['nav.close']),
    ).toEqual([ht['nav.home'], ht['auth.signOut']]);
  });
});
