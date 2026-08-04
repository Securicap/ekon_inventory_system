import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, json, mockApi, noContent, offline } from '../helpers/fetchMock.js';
import { productFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp, settle, submitLogin } from '../helpers/renderApp.js';

function signOut(): void {
  fireEvent.click(screen.getByRole('button', { name: ht['auth.signOut'] }));
}

/**
 * Signing out means the server revoked the session — not that the browser
 * forgot about it.
 *
 * The distinction is the whole point on a shared shop laptop: a local-only
 * sign-out would leave a live twelve-hour session behind while telling the
 * person who walked away that they had ended it.
 */
describe('signing out', () => {
  it('asks the server to revoke the session, then shows the login screen', async () => {
    const api = mockApi({
      'GET /api/auth/me': json(userResponse()),
      'POST /api/auth/logout': noContent(),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    signOut();

    expect(await screen.findByLabelText(ht['auth.username'])).toBeInTheDocument();
    expect(screen.queryByText('Marie Joseph')).toBeNull();

    const [request] = api.to('POST /api/auth/logout');
    expect(request?.credentials).toBe('same-origin');
    expect(Object.keys(request?.headers ?? {})).not.toContain('x-ekon-operation-id');
    expect(request?.body).toBeUndefined();
  });

  it('does not announce an ended session when the person ended it themselves', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'POST /api/auth/logout': noContent(),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    signOut();
    await screen.findByLabelText(ht['auth.username']);

    expect(screen.queryByText(ht['error.sessionExpired'])).toBeNull();
  });

  it('drops the data the session opened', async () => {
    const { queryClient } = (() => {
      mockApi({
        'GET /api/auth/me': json(userResponse()),
        'GET /api/catalog/products': json([productFixture()]),
        'POST /api/auth/logout': noContent(),
      });
      return renderApp();
    })();

    await screen.findByText('Marie Joseph');
    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByText('Diri');

    expect(queryClient.getQueryData(['catalog', 'products'])).toBeDefined();

    signOut();
    await screen.findByLabelText(ht['auth.username']);

    // Nothing the next person to use this laptop could read out of the cache.
    expect(queryClient.getQueryData(['catalog', 'products'])).toBeUndefined();
    expect(queryClient.getQueryData(['auth', 'me'])).toBeNull();
    expect(screen.queryByText('Diri')).toBeNull();
  });

  it('does not re-ask who is signed in behind the login screen', async () => {
    const api = mockApi({
      'GET /api/auth/me': json(userResponse()),
      'POST /api/auth/logout': noContent(),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    signOut();
    await screen.findByLabelText(ht['auth.username']);
    await settle();

    expect(api.to('GET /api/auth/me')).toHaveLength(1);
  });

  it('is safe to repeat: signing in and out again works the same way', async () => {
    const api = mockApi({
      'GET /api/auth/me': json(userResponse()),
      'POST /api/auth/login': json(userResponse()),
      'POST /api/auth/logout': noContent(),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    signOut();
    await screen.findByLabelText(ht['auth.username']);

    submitLogin({ username: 'marie.j', password: 'chwal vèt kanpe' });
    await screen.findByText('Marie Joseph');

    signOut();
    await screen.findByLabelText(ht['auth.username']);

    expect(api.to('POST /api/auth/logout')).toHaveLength(2);
  });

  it('stays honest when the request never reached the server', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'POST /api/auth/logout': [offline(), noContent()],
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    signOut();

    // The server session may well still be live, so the application does not
    // claim otherwise: the person stays signed in and is told to try again.
    expect(await screen.findByRole('alert')).toHaveTextContent(ht['auth.signOutFailed']);
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();

    // The button is the retry.
    signOut();
    expect(await screen.findByLabelText(ht['auth.username'])).toBeInTheDocument();
  });

  it('signs out even when the session had already expired', async () => {
    // Logout answers 204 whether the token was live, expired, revoked, or
    // absent, so success needs no interpretation here.
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'POST /api/auth/logout': noContent(),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    signOut();
    await waitFor(() => expect(screen.getByLabelText(ht['auth.username'])).toBeInTheDocument());
  });

  it('reports a server failure rather than pretending the session is gone', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'POST /api/auth/logout': apiFailure('INTERNAL', 500),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    signOut();

    expect(await screen.findByRole('alert')).toHaveTextContent(ht['auth.signOutFailed']);
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
  });
});
