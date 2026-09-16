import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import fr from '../../src/i18n/fr.json';
import { apiFailure, json, mockApi } from '../helpers/fetchMock.js';
import { userFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp, settle } from '../helpers/renderApp.js';

/**
 * The first ninety seconds of an installation.
 *
 * Somebody has installed Ekon on the shop computer and opened the browser. The
 * database is empty, so there is no account to sign in to and nobody who could
 * be authorized to create one — and a login form would be a dead end. The
 * server says so on the call the application already makes on every page load,
 * and this is what the browser does about it.
 */

const OWNER = {
  username: 'marie.j',
  displayName: 'Marie Joseph',
  password: 'correct horse battery staple',
};

/** Fills the first-run form the way the person installing it would. */
function fillSetupForm(values: Partial<typeof OWNER> & { confirmation?: string } = {}): void {
  const filled = { ...OWNER, confirmation: values.password ?? OWNER.password, ...values };

  fireEvent.change(screen.getByLabelText(ht['setup.username']), {
    target: { value: filled.username },
  });
  fireEvent.change(screen.getByLabelText(ht['setup.displayName']), {
    target: { value: filled.displayName },
  });
  fireEvent.change(screen.getByLabelText(ht['setup.password']), {
    target: { value: filled.password },
  });
  fireEvent.change(screen.getByLabelText(ht['setup.confirmation']), {
    target: { value: filled.confirmation },
  });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: ht['setup.submit'] }));
}

describe('first-run setup', () => {
  it('shows the setup screen when the installation has no accounts', async () => {
    mockApi({ 'GET /api/auth/me': json({ state: 'setup' }) });
    renderApp();

    await screen.findByRole('heading', { name: ht['setup.heading'] });

    // Not the login form, which nobody could use, and not the shell.
    expect(screen.queryByRole('heading', { name: ht['auth.signInHeading'] })).toBeNull();
    expect(screen.queryByRole('button', { name: ht['auth.signIn'] })).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('sends exactly the three fields the route accepts', async () => {
    const api = mockApi({
      'GET /api/auth/me': json({ state: 'setup' }),
      'POST /api/setup/owner': json(userResponse(userFixture({ role: 'OWNER' })), 201),
    });
    renderApp();

    await screen.findByRole('heading', { name: ht['setup.heading'] });
    fillSetupForm();
    submit();

    await waitFor(() => expect(api.to('POST /api/setup/owner')).toHaveLength(1));
    const [request] = api.to('POST /api/setup/owner');

    // No role, no id, no capability list — the server's schema is strict and
    // this is a public route on an empty database.
    expect(request?.body).toEqual({
      username: 'marie.j',
      displayName: 'Marie Joseph',
      password: OWNER.password,
    });
    expect(request?.credentials).toBe('same-origin');
    // Not a ledger command: a repeat is a 409, not a replay.
    expect(Object.keys(request?.headers ?? {})).not.toContain('x-ekon-operation-id');
  });

  it('hands over to the login screen once the owner exists', async () => {
    // Creating the account does not sign anybody in. The password is proven by
    // being typed into the form it will be typed into every morning, while the
    // person who chose it is still standing there — and there is no
    // self-service reset if it turns out to be wrong.
    mockApi({
      'GET /api/auth/me': json({ state: 'setup' }),
      'POST /api/setup/owner': json(userResponse(userFixture({ role: 'OWNER' })), 201),
    });
    renderApp();

    await screen.findByRole('heading', { name: ht['setup.heading'] });
    fillSetupForm();
    submit();

    await screen.findByRole('heading', { name: ht['auth.signInHeading'] });
    // And not as "your session ended", which would be a lie to somebody who
    // installed this thirty seconds ago.
    expect(screen.queryByText(ht['error.sessionExpired'])).toBeNull();
  });

  it('does not ask the server again after setting up', async () => {
    const api = mockApi({
      'GET /api/auth/me': json({ state: 'setup' }),
      'POST /api/setup/owner': json(userResponse(userFixture({ role: 'OWNER' })), 201),
    });
    renderApp();

    await screen.findByRole('heading', { name: ht['setup.heading'] });
    fillSetupForm();
    submit();
    await screen.findByRole('heading', { name: ht['auth.signInHeading'] });
    await settle();

    // The answer is known: nobody is signed in. Re-asking would be a round trip
    // for a question this browser just watched being answered.
    expect(api.to('GET /api/auth/me')).toHaveLength(1);
  });

  it('never puts the password anywhere but the request body', async () => {
    const api = mockApi({
      'GET /api/auth/me': json({ state: 'setup' }),
      'POST /api/setup/owner': json(userResponse(userFixture({ role: 'OWNER' })), 201),
    });
    renderApp();

    await screen.findByRole('heading', { name: ht['setup.heading'] });
    fillSetupForm();
    submit();
    await screen.findByRole('heading', { name: ht['auth.signInHeading'] });

    for (const request of api.requests) {
      if (request.url === '/api/setup/owner') continue;
      expect(JSON.stringify(request)).not.toContain(OWNER.password);
    }
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  describe('what the form checks before sending anything', () => {
    it('refuses two passwords that do not match, without a round trip', async () => {
      // The one place in this application where a typo is unrecoverable without
      // a database: there is no reset, and no second account to recover from.
      const api = mockApi({ 'GET /api/auth/me': json({ state: 'setup' }) });
      renderApp();

      await screen.findByRole('heading', { name: ht['setup.heading'] });
      fillSetupForm({ confirmation: 'something else entirely' });
      submit();

      expect(await screen.findByText(ht['setup.passwordMismatch'])).toBeVisible();
      expect(api.to('POST /api/setup/owner')).toHaveLength(0);
    });

    it('refuses a password that is too short, and says so under the field', async () => {
      const api = mockApi({ 'GET /api/auth/me': json({ state: 'setup' }) });
      renderApp();

      await screen.findByRole('heading', { name: ht['setup.heading'] });
      fillSetupForm({ password: 'short' });
      submit();

      expect(
        await screen.findByText(ht['setup.passwordTooShort'].replace('{min}', '10')),
      ).toBeVisible();
      expect(api.to('POST /api/setup/owner')).toHaveLength(0);
    });

    it('refuses a username that is not one', async () => {
      const api = mockApi({ 'GET /api/auth/me': json({ state: 'setup' }) });
      renderApp();

      await screen.findByRole('heading', { name: ht['setup.heading'] });
      fillSetupForm({ username: 'Marie Joseph!' });
      submit();

      expect(await screen.findByText(ht['setup.usernameInvalid'])).toBeVisible();
      expect(api.to('POST /api/setup/owner')).toHaveLength(0);
    });

    it('sends the normalized username, the one that will sign in', async () => {
      const api = mockApi({
        'GET /api/auth/me': json({ state: 'setup' }),
        'POST /api/setup/owner': json(userResponse(userFixture({ role: 'OWNER' })), 201),
      });
      renderApp();

      await screen.findByRole('heading', { name: ht['setup.heading'] });
      fillSetupForm({ username: '  Marie.J  ' });
      submit();

      await waitFor(() => expect(api.to('POST /api/setup/owner')).toHaveLength(1));
      expect((api.to('POST /api/setup/owner')[0]?.body as { username: string }).username).toBe(
        'marie.j',
      );
    });
  });

  describe('when the server refuses', () => {
    it('says somebody else set this installation up', async () => {
      // A second browser tab, a colleague, or the operator command, while this
      // form was open. The remedy is to sign in, not to try again.
      mockApi({
        'GET /api/auth/me': json({ state: 'setup' }),
        'POST /api/setup/owner': apiFailure('SETUP_COMPLETE', 409),
      });
      renderApp();

      await screen.findByRole('heading', { name: ht['setup.heading'] });
      fillSetupForm();
      submit();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(ht['setup.alreadyComplete']);
      // The screen stays: the next page load will show the login form anyway.
      expect(screen.getByRole('heading', { name: ht['setup.heading'] })).toBeVisible();
    });

    it('reports an unreachable server as itself', async () => {
      mockApi({
        'GET /api/auth/me': json({ state: 'setup' }),
        'POST /api/setup/owner': apiFailure('INTERNAL', 500),
      });
      renderApp();

      await screen.findByRole('heading', { name: ht['setup.heading'] });
      fillSetupForm();
      submit();

      expect(await screen.findByRole('alert')).toHaveTextContent(ht['error.generic']);
    });

    it('moves focus to the reason, so a keyboard lands on it', async () => {
      mockApi({
        'GET /api/auth/me': json({ state: 'setup' }),
        'POST /api/setup/owner': apiFailure('SETUP_COMPLETE', 409),
      });
      renderApp();

      await screen.findByRole('heading', { name: ht['setup.heading'] });
      fillSetupForm();
      submit();

      const alert = await screen.findByRole('alert');
      await waitFor(() => expect(alert).toHaveFocus());
    });
  });

  it('reads the same in French', () => {
    // Every string on this screen exists in both catalogues, and the
    // placeholders match. The convention check enforces it across the whole
    // application; this is the screen-level statement of it.
    for (const key of [
      'setup.heading',
      'setup.description',
      'setup.username',
      'setup.displayName',
      'setup.password',
      'setup.confirmation',
      'setup.submit',
      'setup.noReset',
      'setup.passwordMismatch',
      'setup.alreadyComplete',
    ] as const) {
      expect(fr[key], key).toBeTruthy();
      expect(fr[key], key).not.toBe(ht[key]);
    }
  });
});
