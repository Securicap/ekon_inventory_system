import { screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, mockApi, offline } from '../helpers/fetchMock.js';
import { userFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp, settle } from '../helpers/renderApp.js';

/**
 * Starting the application: asking the server who this is, before rendering
 * anything that assumes an answer.
 *
 * The session lives on the server. The browser holds an `HttpOnly` cookie it
 * cannot read, so the only way to know whether anybody is signed in is to ask,
 * and every page load asks. Nothing is remembered between loads on purpose —
 * these tests assert that too.
 */
describe('session bootstrap', () => {
  it('asks the server who is signed in, with credentials', async () => {
    const api = mockApi({ 'GET /api/auth/me': json(userResponse()) });
    renderApp();

    await screen.findByText('Marie Joseph');

    const [request] = api.to('GET /api/auth/me');
    expect(request?.credentials).toBe('same-origin');
    // Auth is not a ledger command; it carries no operation id.
    expect(Object.keys(request?.headers ?? {})).not.toContain('x-ekon-operation-id');
  });

  it('shows a loading state, and no protected content, until the answer arrives', async () => {
    const me = deferred();
    mockApi({ 'GET /api/auth/me': me.responder });
    renderApp();

    expect(screen.getByRole('status')).toHaveTextContent(ht['app.loading']);

    // Neither half of the answer is guessed at while it is unknown: no shell,
    // and no login form either.
    expect(screen.queryByRole('button', { name: ht['auth.signOut'] })).toBeNull();
    expect(screen.queryByLabelText(ht['auth.username'])).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();

    me.resolve(json(userResponse()));
    await screen.findByText('Marie Joseph');
  });

  it('renders the authenticated shell when the session is valid', async () => {
    mockApi({ 'GET /api/auth/me': json(userResponse()) });
    renderApp();

    await screen.findByText('Marie Joseph');
    expect(screen.getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
    expect(screen.getByText(ht['home.welcome'].replace('{name}', 'Marie Joseph'))).toBeVisible();
  });

  it('renders the login screen when there is no session', async () => {
    mockApi({ 'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401) });
    renderApp();

    expect(await screen.findByLabelText(ht['auth.username'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['auth.password'])).toBeInTheDocument();
  });

  it('does not announce an ended session to somebody who never had one', async () => {
    mockApi({ 'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401) });
    renderApp();

    await screen.findByLabelText(ht['auth.username']);
    expect(screen.queryByText(ht['error.sessionExpired'])).toBeNull();
  });

  it('does not retry a 401, which is an answer rather than a failure', async () => {
    const api = mockApi({ 'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401) });
    renderApp();

    await screen.findByLabelText(ht['auth.username']);
    await settle();
    expect(api.to('GET /api/auth/me')).toHaveLength(1);
  });

  it('offers a retry, and never a login form, when the server cannot be reached', async () => {
    mockApi({ 'GET /api/auth/me': offline() });
    renderApp();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.network']);
    expect(screen.getByRole('button', { name: ht['action.retry'] })).toBeInTheDocument();

    // A dropped connection is not evidence that nobody is signed in, so it must
    // not invite somebody to type a password into it.
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
  });

  it('reaches the shell when a retry succeeds', async () => {
    mockApi({ 'GET /api/auth/me': [offline(), json(userResponse())] });
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: ht['action.retry'] }));

    await screen.findByText('Marie Joseph');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a server failure with its request id rather than a login form', async () => {
    mockApi({ 'GET /api/auth/me': apiFailure('INTERNAL', 500, 'req-99') });
    renderApp();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.generic']);
    expect(alert).toHaveTextContent('req-99');
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
  });

  it('keeps nothing about the session in browser storage', async () => {
    mockApi({ 'GET /api/auth/me': json(userResponse()) });
    renderApp();

    await screen.findByText('Marie Joseph');
    await waitFor(() => {
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    });
  });

  it('reflects the capabilities the server returned, not a role name', async () => {
    // An OWNER whose capabilities have been taken away sees no navigation for
    // them. Nothing branches on the role.
    mockApi({ 'GET /api/auth/me': json(userResponse(userFixture({ capabilities: [] }))) });
    renderApp();

    await screen.findByText('Marie Joseph');
    expect(screen.queryByRole('button', { name: ht['nav.products'] })).toBeNull();
    expect(screen.queryByRole('button', { name: ht['nav.stock'] })).toBeNull();
  });
});
