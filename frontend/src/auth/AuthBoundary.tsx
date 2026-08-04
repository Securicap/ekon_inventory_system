import type { ReactNode } from 'react';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useTranslator } from '../i18n/index.js';
import { LoginScreen } from './LoginScreen.js';
import { useAuth } from './useAuth.js';

/**
 * The line between "we do not know yet" and the application.
 *
 * Nothing protected is rendered until the server has answered who this is. Not
 * as a security measure — the API is the authority, and it refuses an
 * unauthenticated request whatever the browser has drawn — but because an
 * application that flashes a shell and then replaces it with a login form has
 * told somebody at the counter that they were signed in when they were not, and
 * has fired the reads to prove it.
 *
 * This is the whole of the application's routing. There is one boundary and,
 * inside it, a shell that swaps its main panel. A router would buy addressable
 * URLs for three temporary screens, and would have to be replaced along with
 * them.
 */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const t = useTranslator();
  const { state, retryBootstrap } = useAuth();

  switch (state.status) {
    case 'loading':
      return (
        <main className="flex flex-1 items-center justify-center p-6">
          <p role="status" className="text-lg text-slate-600">
            {t('app.loading')}
          </p>
        </main>
      );

    case 'error':
      // We could not reach the server, so we do not know whether anybody is
      // signed in — and we do not guess. Showing the login form here would
      // invite somebody to type a password into a dropped connection.
      return (
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
          <h1 className="text-2xl font-semibold text-slate-900">{t('app.name')}</h1>
          <ErrorNotice error={state.error} onRetry={retryBootstrap} />
        </main>
      );

    case 'unauthenticated':
      return <LoginScreen sessionEnded={state.reason === 'session-ended'} />;

    case 'authenticated':
      return <>{children}</>;
  }
}
