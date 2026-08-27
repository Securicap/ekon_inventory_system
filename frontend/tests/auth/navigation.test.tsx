import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_CAPABILITIES, type Capability, type Role } from '@ekon/shared';
import { hasCapability } from '../../src/auth/capabilities.js';
import ht from '../../src/i18n/ht.json';
import { json, mockApi } from '../helpers/fetchMock.js';
import { locationFixture, productFixture, userFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp } from '../helpers/renderApp.js';

async function signedInAs(options: {
  capabilities: readonly Capability[];
  role?: Role;
}): Promise<void> {
  mockApi({
    'GET /api/auth/me': json(
      userResponse(
        userFixture(
          options.role
            ? { capabilities: options.capabilities, role: options.role }
            : { capabilities: options.capabilities },
        ),
      ),
    ),
    'GET /api/catalog/products': json([productFixture()]),
    'GET /api/inventory/locations': json([locationFixture()]),
    'GET /api/inventory/balances': json([]),
  });
  renderApp();
  await screen.findByText('Marie Joseph');
}

/**
 * The shell's own navigation, and only it.
 *
 * Scoped to the `nav` rather than to every button on the page: Home offers
 * shortcuts to the same destinations, and a helper that counted those too would
 * be asserting the landing screen's contents while claiming to assert the
 * sidebar's.
 */
function navigation(): string[] {
  return within(screen.getByRole('navigation', { name: ht['nav.main'] }))
    .getAllByRole('button')
    .map((button) => button.textContent ?? '');
}

/**
 * What the shell offers is decided by capability, and only for screens that
 * exist.
 *
 * This is usability, not security: the capability list arrives from `/me` and
 * lives in a browser, where anything can be edited, and every request is
 * checked again by the server. Hiding a link somebody cannot use is worth doing
 * anyway — an employee should not be shown a door that will be shut in their
 * face at the counter.
 */
describe('capability-aware navigation', () => {
  it('offers the catalog to somebody who may read it', async () => {
    await signedInAs({ capabilities: ['catalog.read'] });
    expect(screen.getByRole('button', { name: ht['nav.products'] })).toBeInTheDocument();
  });

  it('does not offer the catalog without catalog.read', async () => {
    await signedInAs({ capabilities: ['inventory.read'] });
    expect(screen.queryByRole('button', { name: ht['nav.products'] })).toBeNull();
  });

  it('offers stock locations to somebody who may read inventory', async () => {
    await signedInAs({ capabilities: ['inventory.read'] });
    expect(screen.getByRole('button', { name: ht['nav.stock'] })).toBeInTheDocument();
  });

  it('does not offer stock locations without inventory.read', async () => {
    await signedInAs({ capabilities: ['catalog.read'] });
    expect(screen.queryByRole('button', { name: ht['nav.stock'] })).toBeNull();
  });

  it('offers receiving to somebody who may receive stock', async () => {
    await signedInAs({ capabilities: ['inventory.read', 'inventory.receive'] });
    // Counts and History ride on `inventory.read`: seeing what has been counted
    // and how the numbers got there is inventory visibility. Recording a count
    // and accepting a difference need `inventory.count`, and those are gated on
    // the screen rather than at the door.
    expect(navigation()).toEqual([
      ht['nav.home'],
      ht['nav.stock'],
      ht['nav.receive'],
      ht['nav.counts'],
      ht['nav.history'],
    ]);
  });

  it('does not offer receiving to somebody who may only read stock', async () => {
    // Reading stock and booking it in are different permissions. An employee
    // holding only the first must not be shown a door the API will shut.
    await signedInAs({ capabilities: ['inventory.read'] });

    expect(navigation()).toEqual([
      ht['nav.home'],
      ht['nav.stock'],
      ht['nav.counts'],
      ht['nav.history'],
    ]);
    expect(screen.queryByRole('button', { name: ht['nav.receive'] })).toBeNull();
  });

  it('offers receiving on the capability alone, without inventory.read', async () => {
    await signedInAs({ capabilities: ['inventory.receive'] });
    expect(navigation()).toEqual([ht['nav.home'], ht['nav.receive']]);
  });

  it('offers removal to somebody who may remove stock', async () => {
    await signedInAs({ capabilities: ['inventory.read', 'inventory.remove'] });
    expect(navigation()).toEqual([
      ht['nav.home'],
      ht['nav.stock'],
      ht['nav.remove'],
      ht['nav.counts'],
      ht['nav.history'],
    ]);
  });

  it('offers removal on the capability alone, without inventory.read', async () => {
    // Recording that stock left and reading what is on the shelf are different
    // permissions, and holding only the first is a real combination.
    await signedInAs({ capabilities: ['inventory.remove'] });
    expect(navigation()).toEqual([ht['nav.home'], ht['nav.remove']]);
  });

  it('does not offer removal to somebody who may only receive stock', async () => {
    // Putting stock on a shelf and taking it off are different acts that
    // different people are trusted with. Neither key opens the other's door.
    await signedInAs({ capabilities: ['inventory.read', 'inventory.receive'] });
    expect(screen.queryByRole('button', { name: ht['nav.remove'] })).toBeNull();
  });

  it('opens no destination at all for inventory.adjust', async () => {
    // Correcting a balance that was wrong is not recording that stock left, and
    // it is not a place somebody goes: adjusting belongs to the inventory row
    // whose number is wrong. A capability is not a destination, and this one
    // deliberately opens no door of its own — including Remove's.
    await signedInAs({ capabilities: ['inventory.adjust'] });
    expect(navigation()).toEqual([ht['nav.home']]);
    expect(screen.queryByRole('button', { name: ht['nav.remove'] })).toBeNull();
    expect(screen.queryByRole('button', { name: ht['nav.adjust'] })).toBeNull();
  });

  it('opens no destination for inventory.reverse or catalog.deactivate either', async () => {
    // The other two contextual actions. Reversing belongs to a movement in
    // History and withdrawing merchandise belongs to a product on Products;
    // neither is a place, so neither is a door.
    await signedInAs({ capabilities: ['inventory.reverse', 'catalog.deactivate'] });
    expect(navigation()).toEqual([ht['nav.home']]);
  });

  it('offers removal on the employee role default grants', async () => {
    // The operating model the capability exists for: an ordinary employee at
    // the counter can record what leaves, on the grants their role arrives
    // with, without anybody configuring anything.
    await signedInAs({
      role: 'EMPLOYEE',
      capabilities: DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? [],
    });
    // Operations, then control, then management — the order the sidebar groups
    // them in.
    expect(navigation()).toEqual([
      ht['nav.home'],
      ht['nav.stock'],
      ht['nav.receive'],
      ht['nav.remove'],
      ht['nav.counts'],
      ht['nav.history'],
      ht['nav.products'],
    ]);
    // And not the door that would let them make a shortfall disappear.
    expect(screen.queryByRole('button', { name: ht['nav.adjust'] })).toBeNull();
  });

  it('offers account creation, but no audit or reports, for the capabilities that allow them', async () => {
    // `identity.manage` now has a screen — one form that creates an account —
    // so it appears. `audit.read` and `reports.export` still do not: a
    // capability is not a destination, and a link to a screen that does not
    // exist is worse than a missing link.
    await signedInAs({
      capabilities: ['identity.manage', 'audit.read', 'reports.export'],
    });

    expect(navigation()).toEqual([ht['nav.home'], ht['nav.newUser']]);
    expect(screen.queryByText(ht['nav.audit'])).toBeNull();
  });

  it('decides on capabilities, not on the role name', async () => {
    // An OWNER stripped of capabilities sees nothing; an EMPLOYEE granted them
    // sees all three. If any branch anywhere read the role, one of these would
    // fail — an OWNER is exactly the role that "obviously" may receive stock.
    await signedInAs({ role: 'OWNER', capabilities: [] });
    expect(navigation()).toEqual([ht['nav.home']]);

    cleanup();

    await signedInAs({
      role: 'EMPLOYEE',
      capabilities: ['catalog.read', 'inventory.read', 'inventory.receive', 'inventory.remove'],
    });
    expect(navigation()).toEqual([
      ht['nav.home'],
      ht['nav.stock'],
      ht['nav.receive'],
      ht['nav.remove'],
      ht['nav.counts'],
      ht['nav.history'],
      ht['nav.products'],
    ]);
  });

  it('shows the role as a label only', async () => {
    await signedInAs({ role: 'EMPLOYEE', capabilities: ['catalog.read'] });
    expect(screen.getByText(ht['role.EMPLOYEE'])).toBeInTheDocument();
  });

  it('marks the open screen for assistive technology and reaches it by keyboard', async () => {
    await signedInAs({ capabilities: ['catalog.read', 'inventory.read'] });

    const catalog = screen.getByRole('button', { name: ht['nav.products'] });
    catalog.focus();
    expect(catalog).toHaveFocus();

    fireEvent.click(catalog);
    await screen.findByText('Diri');
    expect(catalog).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: ht['nav.home'] })).not.toHaveAttribute(
      'aria-current',
    );
  });
});

describe('hasCapability', () => {
  it('answers from the list the server sent, and nothing else', () => {
    const user = userFixture({ role: 'EMPLOYEE', capabilities: ['catalog.read'] });
    expect(hasCapability(user, 'catalog.read')).toBe(true);
    expect(hasCapability(user, 'catalog.write')).toBe(false);
  });
});
