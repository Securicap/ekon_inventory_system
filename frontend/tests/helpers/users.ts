import { fireEvent, screen } from '@testing-library/react';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi, type FetchMock, type Responder } from './fetchMock.js';
import { userFixture, userResponse } from './fixtures.js';
import { renderApp } from './renderApp.js';

/**
 * Signs in somebody who may create accounts, and opens the screen the way they
 * would: by clicking the navigation entry.
 *
 * No shortcut past authentication and none past the shell — the screen is
 * reached through the same capability check that decides whether it is offered
 * at all, which is half of what these tests are about.
 */

export const CREATE_USER_ROUTE = 'POST /api/identity/users';

/** What the route answers on success, as the shared contract defines it. */
export function createdUser(
  overrides: {
    id?: string;
    username?: string;
    displayName?: string;
    role?: string;
    isActive?: boolean;
    createdAt?: string;
  } = {},
) {
  return {
    user: {
      id: overrides.id ?? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01',
      username: overrides.username ?? 'nadege.l',
      displayName: overrides.displayName ?? 'Nadege Louis',
      role: overrides.role ?? 'EMPLOYEE',
      isActive: overrides.isActive ?? true,
      createdAt: overrides.createdAt ?? '2026-08-03T12:00:00.000Z',
    },
  };
}

export async function openNewUser(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[] } = {},
): Promise<{ api: FetchMock }> {
  const api = mockApi({
    'GET /api/auth/me': json(
      userResponse(
        userFixture({ capabilities: options.capabilities ?? ['identity.manage'], role: 'OWNER' }),
      ),
    ),
    ...routes,
  });

  renderApp();
  await screen.findByText('Marie Joseph');
  fireEvent.click(screen.getByRole('button', { name: ht['nav.newUser'] }));
  await screen.findByRole('heading', { name: ht['users.title'] });

  return { api };
}

/** Fills the form the way somebody at a keyboard would. */
export function fillNewUserForm(
  values: {
    username?: string;
    displayName?: string;
    password?: string;
    role?: string;
  } = {},
): void {
  fireEvent.change(screen.getByLabelText(ht['users.username']), {
    target: { value: values.username ?? 'nadege.l' },
  });
  fireEvent.change(screen.getByLabelText(ht['users.displayName']), {
    target: { value: values.displayName ?? 'Nadege Louis' },
  });
  fireEvent.change(screen.getByLabelText(ht['users.password']), {
    target: { value: values.password ?? 'zoranj kokoye diri' },
  });
  if (values.role !== undefined) {
    fireEvent.change(screen.getByLabelText(ht['users.role']), { target: { value: values.role } });
  }
}

export function submitNewUserForm(): void {
  fireEvent.click(screen.getByRole('button', { name: ht['users.submit'] }));
}

/** The body of `POST /api/identity/users`, as the browser sent it. */
export function createUserRequests(api: FetchMock): Record<string, unknown>[] {
  return api.to(CREATE_USER_ROUTE).map((request) => request.body as Record<string, unknown>);
}
