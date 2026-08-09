import type { ReactNode } from 'react';
import { Brand } from '../components/Brand.js';
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
      // The identity is drawn here, in the place and at the size the login
      // screen and the failure state draw it. All three are the same centred
      // column, so resolving the session moves nothing that was already on the
      // screen — it only fills in what comes below the mark.
      return (
        <main className="flex flex-1 items-center justify-center p-4 md:p-6 lg:p-8">
          <div className="flex w-full max-w-100 flex-col gap-5">
            <Brand variant="hero" level={1} />
            <p role="status" className="text-lg text-ink-soft">
              {t('app.loading')}
            </p>
          </div>
        </main>
      );

    case 'error':
      // We could not reach the server, so we do not know whether anybody is
      // signed in — and we do not guess. Showing the login form here would
      // invite somebody to type a password into a dropped connection.
      return (
        <main className="flex flex-1 items-center justify-center p-4 md:p-6 lg:p-8">
          <div className="flex w-full max-w-100 flex-col gap-5">
            <Brand variant="hero" level={1} />
            <ErrorNotice error={state.error} onRetry={retryBootstrap} />
          </div>
        </main>
      );

    case 'unauthenticated':
      return <LoginScreen sessionEnded={state.reason === 'session-ended'} />;

    case 'authenticated':
      return <>{children}</>;
  }
}
