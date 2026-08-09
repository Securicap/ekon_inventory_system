import { AuthBoundary } from '../auth/AuthBoundary.js';
import { ConnectivityBanner } from '../components/ConnectivityBanner.js';
import { DEFAULT_LOCALE } from '../i18n/index.js';
import { AppShell } from './AppShell.js';

/**
 * The application: a connectivity banner, an authentication boundary, and the
 * shell behind it.
 *
 * The banner sits outside the boundary on purpose. A dropped connection is
 * exactly as worth knowing about while somebody is trying to sign in as it is
 * afterwards — more so, since the failure they would otherwise see is a login
 * form that seems not to work.
 */
export function App() {
  return (
    <div className="flex min-h-full flex-col bg-canvas text-ink">
      <ConnectivityBanner locale={DEFAULT_LOCALE} />
      <AuthBoundary>
        <AppShell />
      </AuthBoundary>
    </div>
  );
}
