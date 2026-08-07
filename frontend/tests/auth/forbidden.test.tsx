import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, json, mockApi } from '../helpers/fetchMock.js';
import { balanceFixture, userFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp, settle } from '../helpers/renderApp.js';

/**
 * A request the server refuses on permission, not on identity.
 *
 * `401` and `403` are different answers with different remedies: one is fixed
 * by signing in, the other by asking the owner. Treating a `403` as a session
 * problem would sign somebody out of an application they are legitimately
 * signed in to, and send them back to a login form that will change nothing.
 */
describe('a forbidden business request', () => {
  it('says so in place, and leaves the person signed in', async () => {
    // The nav still offers the catalog — capabilities said so when the page
    // loaded — and the server refuses the read anyway. That gap is exactly why
    // the screen renders this state instead of assuming it cannot happen.
    mockApi({
      'GET /api/auth/me': json(userResponse(userFixture({ capabilities: ['catalog.read'] }))),
      'GET /api/catalog/products': apiFailure('FORBIDDEN', 403, 'req-forbidden'),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.forbidden']);
    // The request id is what turns a support call into a log line.
    expect(alert).toHaveTextContent('req-forbidden');

    // Still signed in, still able to move around, still able to leave.
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
  });

  it('does not retry it, and does not turn it into a session problem', async () => {
    const api = mockApi({
      'GET /api/auth/me': json(userResponse(userFixture({ capabilities: ['catalog.read'] }))),
      'GET /api/catalog/products': apiFailure('FORBIDDEN', 403),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByRole('alert');
    await settle();

    expect(api.to('GET /api/catalog/products')).toHaveLength(1);
    expect(api.to('GET /api/auth/me')).toHaveLength(1);
    expect(screen.queryByText(ht['error.sessionExpired'])).toBeNull();
  });

  it('leaves the rest of the application working', async () => {
    mockApi({
      'GET /api/auth/me': json(
        userResponse(userFixture({ capabilities: ['catalog.read', 'inventory.read'] })),
      ),
      'GET /api/catalog/products': apiFailure('FORBIDDEN', 403),
      'GET /api/inventory/balances': json([balanceFixture({ productName: 'Diri' })]),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.stock'] }));
    expect(await screen.findByText('Diri')).toBeInTheDocument();
  });
});
