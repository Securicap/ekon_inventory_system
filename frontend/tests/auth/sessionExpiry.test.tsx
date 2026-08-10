import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, json, mockApi } from '../helpers/fetchMock.js';
import { balanceFixture, productFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp, settle } from '../helpers/renderApp.js';

/**
 * A session that ends while somebody is using the application.
 *
 * It can end without anybody here doing anything: the twelve hours run out, an
 * owner revokes the session, or an account is deactivated — and the first the
 * browser hears of it is a `401` on an ordinary read. What must not happen is a
 * screen that keeps retrying it, or one that goes on showing stock to somebody
 * the server no longer recognizes.
 */
describe('a session that ends mid-use', () => {
  it('shows the login screen, and says why, when a protected read is refused', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'GET /api/catalog/products': apiFailure('UNAUTHENTICATED', 401),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));

    expect(await screen.findByLabelText(ht['auth.username'])).toBeInTheDocument();
    // This browser watched the session end, so it can say so honestly.
    expect(screen.getByText(ht['error.sessionExpired'])).toBeInTheDocument();
  });

  it('removes the protected screen and the person it was showing', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'GET /api/catalog/products': apiFailure('SESSION_EXPIRED', 401),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByLabelText(ht['auth.username']);

    expect(screen.queryByText('Marie Joseph')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: ht['auth.signOut'] })).toBeNull();
  });

  it('does not loop: the refused read is asked once and dropped', async () => {
    const api = mockApi({
      'GET /api/auth/me': json(userResponse()),
      'GET /api/catalog/products': apiFailure('UNAUTHENTICATED', 401),
    });
    const { queryClient } = renderApp();
    await screen.findByText('Marie Joseph');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByLabelText(ht['auth.username']);
    await settle();

    expect(api.to('GET /api/catalog/products')).toHaveLength(1);
    // Nor does it re-ask who is signed in: the 401 already answered that.
    expect(api.to('GET /api/auth/me')).toHaveLength(1);
    expect(queryClient.getQueryData(['catalog', 'products'])).toBeUndefined();
  });

  it('leaves nothing a signed-out browser could still read', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'GET /api/inventory/balances': json([balanceFixture({ productName: 'Diri' })]),
      'GET /api/catalog/products': [json([productFixture()]), apiFailure('UNAUTHENTICATED', 401)],
    });
    const { queryClient } = renderApp();
    await screen.findByText('Marie Joseph');

    // Read two screens, then have the session end on the third request.
    fireEvent.click(screen.getByRole('button', { name: ht['nav.stock'] }));
    // Stock is a register too: one row per variant balance, named by the
    // product it is a balance of.
    await screen.findByRole('rowheader', { name: 'Diri' });
    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    // The catalog is a register: a product is a row-group header over its
    // variants, not a heading over a card.
    await screen.findByRole('rowheader', { name: 'Diri' });

    void queryClient.refetchQueries({ queryKey: ['catalog', 'products'] });

    await screen.findByLabelText(ht['auth.username']);
    expect(queryClient.getQueryData(['inventory', 'balances'])).toBeUndefined();
    expect(queryClient.getQueryData(['catalog', 'products'])).toBeUndefined();
    expect(screen.queryByText('Diri')).toBeNull();
  });
});
