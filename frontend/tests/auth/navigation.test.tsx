import { cleanup, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Capability, Role } from '@ekon/shared';
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
  });
  renderApp();
  await screen.findByText('Marie Joseph');
}

function navigation(): string[] {
  return screen
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((label) => label !== ht['auth.signOut']);
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
    expect(navigation()).toEqual([ht['nav.home'], ht['nav.stock'], ht['nav.receive']]);
  });

  it('does not offer receiving to somebody who may only read stock', async () => {
    // Reading stock and booking it in are different permissions. An employee
    // holding only the first must not be shown a door the API will shut.
    await signedInAs({ capabilities: ['inventory.read'] });

    expect(navigation()).toEqual([ht['nav.home'], ht['nav.stock']]);
    expect(screen.queryByRole('button', { name: ht['nav.receive'] })).toBeNull();
  });

  it('offers receiving on the capability alone, without inventory.read', async () => {
    await signedInAs({ capabilities: ['inventory.receive'] });
    expect(navigation()).toEqual([ht['nav.home'], ht['nav.receive']]);
  });

  it('offers no user management, audit, or reports for the capabilities that allow them', async () => {
    await signedInAs({
      capabilities: ['identity.manage', 'audit.read', 'reports.export'],
    });

    expect(navigation()).toEqual([ht['nav.home']]);
    expect(screen.queryByText(ht['nav.users'])).toBeNull();
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
      capabilities: ['catalog.read', 'inventory.read', 'inventory.receive'],
    });
    expect(navigation()).toEqual([
      ht['nav.home'],
      ht['nav.products'],
      ht['nav.stock'],
      ht['nav.receive'],
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
