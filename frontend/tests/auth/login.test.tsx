import { cleanup, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, mockApi, offline } from '../helpers/fetchMock.js';
import { userResponse } from '../helpers/fixtures.js';
import { renderApp, settle, submitLogin } from '../helpers/renderApp.js';

const PASSWORD = 'chwal vèt kanpe';

/** The login form, reached by starting the application with no session. */
async function renderLogin() {
  const api = mockApi({
    'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401),
    'POST /api/auth/login': json(userResponse()),
  });
  const rendered = renderApp();
  await screen.findByLabelText(ht['auth.username']);
  return { api, ...rendered };
}

describe('signing in', () => {
  it('labels both fields and marks them for the browser credential manager', async () => {
    await renderLogin();

    const username = screen.getByLabelText(ht['auth.username']);
    const password = screen.getByLabelText(ht['auth.password']);

    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(password).toHaveAttribute('type', 'password');
  });

  it('sends the credential, normalized by the shared schema, and nothing else', async () => {
    const { api } = await renderLogin();

    submitLogin({ username: '  Marie.J  ', password: `  ${PASSWORD}  ` });
    await screen.findByText('Marie Joseph');

    const [request] = api.to('POST /api/auth/login');
    expect(request?.body).toEqual({
      // Trimmed and lower-cased, exactly as the server stores it.
      username: 'marie.j',
      // Never trimmed: a leading space is a character somebody chose, and
      // removing it would mean the password that was set is not the one that
      // works.
      password: `  ${PASSWORD}  `,
    });
    expect(request?.credentials).toBe('same-origin');
    expect(Object.keys(request?.headers ?? {})).not.toContain('x-ekon-operation-id');
    expect(request?.url).not.toContain(PASSWORD);
  });

  it('renders the shell and the signed-in person on success', async () => {
    await renderLogin();

    submitLogin({ username: 'marie.j', password: PASSWORD });

    expect(await screen.findByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.getByText(ht['role.OWNER'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
  });

  it('does not ask the server again for a user it was just given', async () => {
    const { api } = await renderLogin();

    submitLogin({ username: 'marie.j', password: PASSWORD });
    await screen.findByText('Marie Joseph');
    await settle();

    // One call at bootstrap, and none after: the login response is the same
    // shape /me returns, so it is the answer.
    expect(api.to('GET /api/auth/me')).toHaveLength(1);
  });

  it('shows one generic message for a rejected credential, and keeps the username', async () => {
    mockApi({
      'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401),
      'POST /api/auth/login': apiFailure('UNAUTHENTICATED', 401),
    });
    renderApp();
    await screen.findByLabelText(ht['auth.username']);

    submitLogin({ username: 'marie.j', password: PASSWORD });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['auth.invalidCredentials']);
    // Focus lands on the reason, not on a form that appears to have done
    // nothing.
    expect(alert).toHaveFocus();

    expect(screen.getByLabelText(ht['auth.username'])).toHaveValue('marie.j');
    expect(screen.getByLabelText(ht['auth.password'])).toHaveValue('');
  });

  it('says the same thing whether the account is unknown, wrong, or deactivated', async () => {
    // The server answers 401 for all three so the form cannot be used to ask
    // which usernames exist. The screen must not reintroduce the difference.
    const messages: string[] = [];

    for (const requestId of ['req-unknown', 'req-wrong', 'req-inactive']) {
      cleanup();
      mockApi({
        'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401),
        'POST /api/auth/login': apiFailure('UNAUTHENTICATED', 401, requestId),
      });
      renderApp();
      await screen.findByLabelText(ht['auth.username']);

      submitLogin({ username: 'marie.j', password: PASSWORD });
      messages.push((await screen.findByRole('alert')).textContent ?? '');
    }

    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toContain(ht['auth.invalidCredentials']);
    // And no request id or server wording that would distinguish the cases.
    expect(messages[0]).not.toContain('req-');
  });

  it('refuses a second submission while one is in flight', async () => {
    const login = deferred();
    const api = mockApi({
      'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401),
      'POST /api/auth/login': login.responder,
    });
    renderApp();
    await screen.findByLabelText(ht['auth.username']);

    const form = screen.getByRole('button', { name: ht['auth.signIn'] }).closest('form');
    submitLogin({ username: 'marie.j', password: PASSWORD });

    expect(screen.getByRole('button', { name: ht['auth.signingIn'] })).toBeDisabled();
    fireEvent.submit(form!);
    fireEvent.submit(form!);
    await settle();

    expect(api.to('POST /api/auth/login')).toHaveLength(1);

    login.resolve(json(userResponse()));
    await screen.findByText('Marie Joseph');
  });

  it('says the field is required before sending an empty form', async () => {
    const { api } = await renderLogin();

    fireEvent.click(screen.getByRole('button', { name: ht['auth.signIn'] }));

    expect(await screen.findByText(ht['auth.usernameRequired'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['auth.username'])).toHaveFocus();
    expect(api.to('POST /api/auth/login')).toHaveLength(0);
  });

  it('checks the password length the shared schema defines, without sending it', async () => {
    const { api } = await renderLogin();

    submitLogin({ username: 'marie.j', password: 'kout' });

    expect(await screen.findByText(ht['auth.passwordTooShort'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['auth.password'])).toHaveFocus();
    expect(api.to('POST /api/auth/login')).toHaveLength(0);
  });

  it('distinguishes an unreachable server from a rejected credential', async () => {
    mockApi({
      'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401),
      'POST /api/auth/login': offline(),
    });
    renderApp();
    await screen.findByLabelText(ht['auth.username']);

    submitLogin({ username: 'marie.j', password: PASSWORD });

    expect(await screen.findByRole('alert')).toHaveTextContent(ht['error.network']);
  });

  it('writes nothing to browser storage, and keeps no copy of the password', async () => {
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    );

    await renderLogin();
    submitLogin({ username: 'marie.j', password: PASSWORD });
    await screen.findByText('Marie Joseph');

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain(PASSWORD);

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(PASSWORD);
      }
      spy.mockRestore();
    }
  });
});
