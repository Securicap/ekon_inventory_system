import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_CAPABILITIES, type Capability } from '@ekon/shared';
import fr from '../../src/i18n/fr.json';
import ht from '../../src/i18n/ht.json';
import { translate, type MessageKey } from '../../src/i18n/index.js';
import { json, mockApi } from '../helpers/fetchMock.js';
import { userFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp } from '../helpers/renderApp.js';

/**
 * Who is shown the door, and whether both languages can describe what is behind
 * it.
 *
 * The capability check here is usability, not security: the list arrives from
 * `/me` and lives in a browser where anything can be edited, and the server
 * checks `identity.manage` again on every request — `identityUsers.test.ts`
 * proves that half. Hiding a link somebody cannot use is worth doing anyway.
 */

async function signedInWith(capabilities: readonly Capability[]): Promise<void> {
  mockApi({
    'GET /api/auth/me': json(userResponse(userFixture({ capabilities }))),
    'GET /api/catalog/products': json([]),
    'GET /api/inventory/locations': json([]),
    'GET /api/inventory/balances': json([]),
  });
  renderApp();
  await screen.findByText('Marie Joseph');
}

describe('who is offered account creation', () => {
  it('offers it to somebody holding identity.manage', async () => {
    await signedInWith(['identity.manage']);
    expect(screen.getByRole('button', { name: ht['nav.newUser'] })).toBeInTheDocument();
  });

  it('does not offer it without identity.manage', async () => {
    await signedInWith(['catalog.read', 'inventory.read']);
    expect(screen.queryByRole('button', { name: ht['nav.newUser'] })).not.toBeInTheDocument();
  });

  it('does not offer it to an employee holding every capability their role grants', async () => {
    // The role that will use this application most, and the one that must never
    // be able to create accounts. Its real seeded grants, not a hand-picked list.
    await signedInWith(DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? []);
    expect(screen.queryByRole('button', { name: ht['nav.newUser'] })).not.toBeInTheDocument();
  });

  it('does not offer it to a manager, who holds everything except identity.manage', async () => {
    await signedInWith(DEFAULT_ROLE_CAPABILITIES.MANAGER ?? []);
    expect(screen.queryByRole('button', { name: ht['nav.newUser'] })).not.toBeInTheDocument();
  });

  it('offers it to an owner through their seeded grants', async () => {
    await signedInWith(DEFAULT_ROLE_CAPABILITIES.OWNER ?? []);
    expect(screen.getByRole('button', { name: ht['nav.newUser'] })).toBeInTheDocument();
  });
});

/**
 * Every string this workflow added exists in both languages, and the screen
 * reads its text from the catalogue rather than from the component.
 *
 * Employees use this in Haitian Creole and the owner reads French. The
 * application renders in Creole today because there is no language selector;
 * French is asserted through the catalogue, which is what the selector will
 * read when it arrives.
 */
const KEYS_ADDED_BY_ACCOUNT_CREATION = [
  'nav.newUser',
  'users.title',
  'users.description',
  'users.username',
  'users.usernameHint',
  'users.displayName',
  'users.displayNameHint',
  'users.password',
  'users.passwordHint',
  'users.role',
  'users.roleHint',
  'users.submit',
  'users.submitting',
  'users.createdLabel',
  'users.success',
  'users.successHint',
  'users.createAnother',
  'users.usernameTaken',
  'users.usernameRequired',
  'users.usernameInvalid',
  'users.displayNameRequired',
  'users.displayNameTooLong',
  'users.passwordRequired',
  'users.passwordTooShort',
  'users.passwordTooLong',
  'users.roleRequired',
] as const satisfies readonly MessageKey[];

describe('localization', () => {
  it.each(KEYS_ADDED_BY_ACCOUNT_CREATION)('has %s in both catalogues', (key) => {
    expect(ht[key]).toBeTruthy();
    expect(fr[key as keyof typeof fr]).toBeTruthy();
  });

  it('translates every one of them to something different in each language', () => {
    // A key copied across untranslated is the failure this catches: the French
    // catalogue is not a duplicate of the Creole one.
    for (const key of KEYS_ADDED_BY_ACCOUNT_CREATION) {
      expect(translate('fr', key), key).not.toBe(translate('ht', key));
    }
  });

  it('keeps the placeholders a message promises', () => {
    for (const [key, placeholder] of [
      ['users.success', '{name}'],
      ['users.successHint', '{username}'],
      ['users.passwordHint', '{min}'],
      ['users.usernameInvalid', '{min}'],
      ['users.passwordTooShort', '{min}'],
      ['users.displayNameTooLong', '{max}'],
    ] as const) {
      expect(ht[key], key).toContain(placeholder);
      expect(fr[key], key).toContain(placeholder);
    }
  });

  it('substitutes them rather than printing the braces', () => {
    expect(translate('ht', 'users.success', { name: 'Nadege' })).toContain('Nadege');
    expect(translate('ht', 'users.success', { name: 'Nadege' })).not.toContain('{name}');
    expect(translate('fr', 'users.successHint', { username: 'nadege.l' })).toContain('nadege.l');
  });

  it('renders the screen from the catalogue, in the primary language', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse(userFixture({ capabilities: ['identity.manage'] }))),
    });
    renderApp();
    await screen.findByText('Marie Joseph');
    screen.getByRole('button', { name: ht['nav.newUser'] }).click();

    expect(await screen.findByRole('heading', { name: ht['users.title'] })).toBeInTheDocument();
    expect(screen.getByText(ht['users.description'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['users.username'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['users.displayName'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['users.password'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['users.role'])).toBeInTheDocument();
  });
});
