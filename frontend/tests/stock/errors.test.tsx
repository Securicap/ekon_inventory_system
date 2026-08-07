import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, json, offline } from '../helpers/fetchMock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import { settle } from '../helpers/renderApp.js';
import { BALANCES_ROUTE, openStock, refreshButton } from '../helpers/stock.js';

/**
 * When the stock read does not answer.
 *
 * Three different failures with three different remedies, and the screen must
 * not confuse them. "You may not do this" is fixed by asking the owner; "the
 * session ended" is fixed by signing in again; "the server did not answer" is
 * fixed by pressing the button again. Rendering all three as one red box would
 * make the screen useless exactly when it matters.
 */

const RICE = balanceFixture({
  productName: 'Diri',
  locations: [{ locationName: 'Main Store', isDefault: true, quantity: 5 }],
});

describe('a stock read the server refuses', () => {
  it('says so in place and leaves the person signed in', async () => {
    await openStock({ [BALANCES_ROUTE]: apiFailure('FORBIDDEN', 403, 'req-forbidden') });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.forbidden']);
    expect(alert).toHaveTextContent('req-forbidden');
    // Never the server's English, which is written for a log line.
    expect(alert).not.toHaveTextContent('English:');

    // Still signed in, still inside the shell, still able to leave.
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
  });

  it('does not retry a 403 and does not treat it as a session problem', async () => {
    const { api } = await openStock({ [BALANCES_ROUTE]: apiFailure('FORBIDDEN', 403) });
    await screen.findByRole('alert');
    await settle();

    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
    expect(api.to('GET /api/auth/me')).toHaveLength(1);
    expect(screen.queryByText(ht['error.sessionExpired'])).toBeNull();
  });

  it('shows no empty-shop message beside the failure', async () => {
    // "We stock nothing" and "we could not find out" are different answers.
    await openStock({ [BALANCES_ROUTE]: apiFailure('FORBIDDEN', 403) });
    await screen.findByRole('alert');

    expect(screen.queryByText(ht['stock.noVariants'])).toBeNull();
    expect(screen.queryByText(ht['stock.noMatches'])).toBeNull();
  });
});

describe('a session that ended under the stock screen', () => {
  it('follows the application-wide rule and shows the login form', async () => {
    const { api, queryClient } = await openStock({
      [BALANCES_ROUTE]: apiFailure('UNAUTHENTICATED', 401),
    });

    await screen.findByLabelText(ht['auth.username']);
    expect(screen.queryByText('Marie Joseph')).toBeNull();
    // Nothing a signed-out browser could still read.
    expect(queryClient.getQueryData(['inventory', 'balances'])).toBeUndefined();
    // And it is not re-asked or retried: the 401 already answered it.
    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
    expect(api.to('GET /api/auth/me')).toHaveLength(1);
  });
});

describe('a stock read the server never answered', () => {
  it('renders through the same error notice, in the reader’s language', async () => {
    await openStock({ [BALANCES_ROUTE]: offline() });

    const alert = await screen.findByRole('alert', {}, { timeout: 20_000 });
    expect(alert).toHaveTextContent(ht['error.network']);
  }, 30_000);

  it('recovers when the refresh button is pressed', async () => {
    // The query client retries a dropped connection on its own; this is what
    // somebody does when those retries have run out.
    await openStock({
      [BALANCES_ROUTE]: [
        apiFailure('INTERNAL', 500),
        apiFailure('INTERNAL', 500),
        apiFailure('INTERNAL', 500),
        json([RICE]),
      ],
    });

    const alert = await screen.findByRole('alert', {}, { timeout: 20_000 });
    expect(alert).toBeInTheDocument();

    fireEvent.click(refreshButton());

    expect(await screen.findByText('Diri')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  }, 30_000);
});
