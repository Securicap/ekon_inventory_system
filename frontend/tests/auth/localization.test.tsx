import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fr from '../../src/i18n/fr.json';
import ht from '../../src/i18n/ht.json';
import { apiFailure, json, mockApi } from '../helpers/fetchMock.js';
import { userResponse } from '../helpers/fixtures.js';
import { renderApp, submitLogin } from '../helpers/renderApp.js';

/**
 * Every string this PR added exists in both languages, and every screen it
 * added reads its text from the catalogue rather than from the component.
 *
 * The rule is not decoration. Employees use this in Haitian Creole; a sentence
 * baked into JSX is a sentence that will never be translated, and the owner
 * abroad reads French. `scripts/check-conventions.mjs` catches literal text in
 * a component mechanically — these tests check the other half, which is that
 * what actually renders is what the catalogue says.
 */

const KEYS_ADDED_BY_AUTHENTICATION = [
  'app.loading',
  'nav.main',
  'nav.home',
  'auth.signInHeading',
  'auth.signIn',
  'auth.signingIn',
  'auth.username',
  'auth.password',
  'auth.usernameRequired',
  'auth.usernameInvalid',
  'auth.passwordRequired',
  'auth.passwordTooShort',
  'auth.invalidCredentials',
  'auth.signOut',
  'auth.signingOut',
  'auth.signOutFailed',
  'auth.signedInAs',
  'role.SUPER_ADMIN',
  'role.OWNER',
  'role.MANAGER',
  'role.EMPLOYEE',
  'home.welcome',
  'catalog.title',
  'catalog.empty',
  // `inventory.title` and `inventory.empty` named the location list this
  // screen used to be. The stock screen replaced it, and its strings are
  // asserted in `tests/stock/localization.test.tsx`.
] as const;

describe('translations', () => {
  it('defines every new string in Haitian Creole and in French', () => {
    for (const key of KEYS_ADDED_BY_AUTHENTICATION) {
      expect(ht[key]?.trim(), `ht.${key}`).toBeTruthy();
      expect(fr[key]?.trim(), `fr.${key}`).toBeTruthy();
    }
  });

  it('says something different in each language, rather than one copied to both', () => {
    // `Ekon` and `SKU` are names, not sentences, and are the same in both.
    const shared = KEYS_ADDED_BY_AUTHENTICATION.filter((key) => ht[key] === fr[key]);
    expect(shared).toEqual([]);
  });

  it('names no capability to a user', () => {
    // `catalog.read` is a permission vocabulary, not a phrase anybody at a
    // counter should be shown.
    for (const catalogue of [ht, fr]) {
      for (const value of Object.values(catalogue)) {
        expect(value).not.toMatch(/catalog\.|inventory\.|identity\.|audit\.|reports\./);
      }
    }
  });

  it('renders the login screen from the catalogue', async () => {
    mockApi({ 'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401) });
    renderApp();

    await screen.findByLabelText(ht['auth.username']);
    expect(screen.getByLabelText(ht['auth.password'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['auth.signIn'] })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: ht['auth.signInHeading'] })).toBeInTheDocument();
  });

  it('renders a rejected credential from the catalogue', async () => {
    mockApi({
      'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401),
      'POST /api/auth/login': apiFailure('UNAUTHENTICATED', 401),
    });
    renderApp();
    await screen.findByLabelText(ht['auth.username']);

    submitLogin({ username: 'marie.j', password: 'chwal vèt kanpe' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['auth.invalidCredentials']);
    // Never the server's English, which is written for a log line.
    expect(alert).not.toHaveTextContent('English:');
    expect(alert).not.toHaveTextContent(/Invalid username or password/i);
  });

  it('renders the shell from the catalogue', async () => {
    mockApi({ 'GET /api/auth/me': json(userResponse()) });
    renderApp();

    await screen.findByText('Marie Joseph');
    expect(screen.getByRole('navigation')).toHaveAccessibleName(ht['nav.main']);
    expect(screen.getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
    expect(
      screen.getByText(ht['home.welcome'].replace('{name}', 'Marie Joseph')),
    ).toBeInTheDocument();
  });

  it('renders an empty catalog from the catalogue', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'GET /api/catalog/products': json([]),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    expect(await screen.findByText(ht['catalog.empty'])).toBeInTheDocument();
  });
});
