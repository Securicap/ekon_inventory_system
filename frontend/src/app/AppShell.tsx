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
import { NewUserScreen } from '../screens/NewUserScreen.js';
import { ReceivingScreen } from '../screens/ReceivingScreen.js';
import { RemovalScreen } from '../screens/RemovalScreen.js';

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
type View = 'home' | 'catalog' | 'inventory' | 'receiving' | 'removal' | 'newUser';

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
 *  - a capability is not a destination. A link to a screen that does not exist
 *    is worse than a missing link, so an entry arrives with its screen and not
 *    before. `audit.read` and `reports.export` are still waiting for theirs.
 *
 * Each inventory door has its own key, and the keys are not interchangeable.
 * Receiving is gated on `inventory.receive`, removal on `inventory.remove`, and
 * reading stock on `inventory.read` — three different permissions over three
 * different acts, and somebody may hold any combination of them. Neither write
 * door opens on the read capability, and neither opens on the other's.
 *
 * `inventory.adjust` opens nothing here, deliberately. Recording that stock
 * left is what somebody at the counter does all day; correcting a balance that
 * was wrong is authority over the records themselves, and the screen for it
 * does not exist. A capability is not a destination.
 *
 * `identity.manage` opens one door and it is a narrow one: creating an account.
 * That is the whole of user management that exists, so it is the whole of what
 * the entry promises — it is labelled for the act rather than for the subject,
 * because a link called "Users" that cannot list any would be a lie about what
 * is behind it.
 *
 * The API enforces the same capabilities, which is the boundary that matters;
 * this only decides whether somebody is shown a door that will be shut in their
 * face.
 */
const NAVIGATION: readonly NavigationItem[] = [
  { view: 'home', labelKey: 'nav.home' },
  { view: 'catalog', labelKey: 'nav.products', capability: 'catalog.read' },
  { view: 'inventory', labelKey: 'nav.stock', capability: 'inventory.read' },
  { view: 'receiving', labelKey: 'nav.receive', capability: 'inventory.receive' },
  { view: 'removal', labelKey: 'nav.remove', capability: 'inventory.remove' },
  { view: 'newUser', labelKey: 'nav.newUser', capability: 'identity.manage' },
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
        {view === 'receiving' && <ReceivingScreen />}
        {view === 'removal' && <RemovalScreen />}
        {view === 'newUser' && <NewUserScreen />}
      </main>
    </div>
  );
}
