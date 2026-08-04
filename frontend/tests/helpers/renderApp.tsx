import { act, fireEvent, render, screen } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { App } from '../../src/app/App.js';
import { AppProviders, createQueryClient } from '../../src/app/providers.js';
import ht from '../../src/i18n/ht.json';

/**
 * Renders the real application, inside the real providers, over a mocked
 * `fetch`.
 *
 * Deliberately not a shortcut past authentication. There is no test-only
 * login, no injected user, and no way to start the application already signed
 * in: a test that wants an authenticated shell mocks `/api/auth/me` the way the
 * server would answer it, or types into the form. If the boundary ever stops
 * working, every one of these tests is supposed to notice.
 *
 * The query client is returned so a test can inspect what signing out removed
 * from the cache — the same client the application is using, not a copy.
 */
export function renderApp(): { queryClient: QueryClient } {
  const queryClient = createQueryClient();
  render(
    <AppProviders client={queryClient}>
      <App />
    </AppProviders>,
  );
  return { queryClient };
}

/** Fills the login form and submits it, the way somebody at the counter would. */
export function submitLogin(credentials: { username: string; password: string }): void {
  fireEvent.change(screen.getByLabelText(ht['auth.username']), {
    target: { value: credentials.username },
  });
  fireEvent.change(screen.getByLabelText(ht['auth.password']), {
    target: { value: credentials.password },
  });
  fireEvent.click(screen.getByRole('button', { name: ht['auth.signIn'] }));
}

/** A tick of the event loop, to show that nothing further was requested. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
