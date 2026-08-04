import { useState } from 'react';
import type { Capability, Role } from '@ekon/shared';
import { hasCapability } from '../auth/capabilities.js';
import { SignOutButton } from '../auth/SignOutButton.js';
import { useAuthenticatedUser } from '../auth/useAuth.js';
import { NAV_BUTTON } from '../components/styles.js';
import { useTranslator, type MessageKey } from '../i18n/index.js';
import { CatalogScreen } from '../screens/CatalogScreen.js';
import { HomeScreen } from '../screens/HomeScreen.js';
import { InventoryScreen } from '../screens/InventoryScreen.js';

/**
 * The authenticated shell: who is signed in, how to leave, where to go, and one
 * panel of content.
 *
 * Temporary, and meant to look it. The platform's visual design has not been
 * done, so this is plain semantic HTML with enough Tailwind to be usable at a
 * counter and on a phone. It is not a dashboard: there are no metrics, no
 * charts, and no summary tiles, because inventing numbers before the workflows
 * that produce them exist would be inventing the business's numbers.
 */
type View = 'home' | 'catalog' | 'inventory';

interface NavigationItem {
  view: View;
  labelKey: MessageKey;
  /** Omitted for the landing view, which every signed-in person can see. */
  capability?: Capability;
}

/**
 * What the shell can navigate to — which is only what has been built.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *  - visibility is decided by capability, never by role. There is no
 *    `role === 'OWNER'` anywhere in this application;
 *  - a capability is not a destination. `inventory.receive` is granted to every
 *    employee and is enforced by the API, but there is no receiving screen yet,
 *    so nothing here offers one. A link to a screen that does not exist is
 *    worse than a missing link. The same goes for `identity.manage`,
 *    `audit.read`, and `reports.export`: the entries arrive with the screens.
 */
const NAVIGATION: readonly NavigationItem[] = [
  { view: 'home', labelKey: 'nav.home' },
  { view: 'catalog', labelKey: 'nav.products', capability: 'catalog.read' },
  { view: 'inventory', labelKey: 'nav.stock', capability: 'inventory.read' },
];

/**
 * Roles are shown, not acted on. The label tells somebody which account they
 * are using; what they may do is decided by capabilities, here and on the
 * server.
 */
const ROLE_LABEL_KEYS: Readonly<Record<Role, MessageKey>> = {
  SUPER_ADMIN: 'role.SUPER_ADMIN',
  OWNER: 'role.OWNER',
  MANAGER: 'role.MANAGER',
  EMPLOYEE: 'role.EMPLOYEE',
};

export function AppShell() {
  const t = useTranslator();
  const user = useAuthenticatedUser();
  const [view, setView] = useState<View>('home');

  const available = NAVIGATION.filter(
    (item) => item.capability === undefined || hasCapability(user, item.capability),
  );

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-3">
          <div>
            <h1 className="text-xl font-semibold">{t('app.name')}</h1>
            <p className="text-sm text-slate-600">{t('app.tagline')}</p>
          </div>

          <div className="flex items-center gap-4">
            <p className="text-right text-sm">
              <span className="block font-medium text-slate-900">{user.displayName}</span>
              <span className="block text-slate-600">{t(ROLE_LABEL_KEYS[user.role])}</span>
            </p>
            <SignOutButton />
          </div>
        </div>

        <nav aria-label={t('nav.main')} className="mx-auto w-full max-w-5xl px-2 pb-2">
          <ul className="flex flex-wrap gap-1">
            {available.map((item) => (
              <li key={item.view}>
                <button
                  type="button"
                  className={NAV_BUTTON}
                  aria-current={item.view === view ? 'page' : undefined}
                  onClick={() => setView(item.view)}
                >
                  {t(item.labelKey)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 p-4">
        {view === 'home' && <HomeScreen />}
        {view === 'catalog' && <CatalogScreen />}
        {view === 'inventory' && <InventoryScreen />}
      </main>
    </div>
  );
}
