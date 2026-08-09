import type { ReactNode } from 'react';
import { useAuthenticatedUser } from '../../auth/useAuth.js';
import { useTranslator } from '../../i18n/index.js';
import type { NavigationItem, View } from '../navigation.js';
import { Brand } from './Brand.js';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus';

const ACCOUNT_BUTTON =
  `inline-flex min-h-11 max-w-[55%] items-center gap-1.5 rounded-md border border-line-strong ` +
  `bg-surface px-3 py-1.5 text-sm font-semibold text-ink hover:bg-fill ${FOCUS}`;

/**
 * A bottom-bar tab: 64px tall, an equal share of the width, and the current one
 * marked by a rule along its top edge as well as by fill and weight.
 */
const TAB =
  `flex min-h-16 flex-1 items-center justify-center border-t-[3px] border-transparent px-1 ` +
  `text-center text-sm leading-tight font-semibold text-ink hyphens-auto ` +
  `border-l border-l-rule first:border-l-0 hover:bg-fill ` +
  `aria-[current=page]:border-t-accent aria-[current=page]:bg-accent-soft ` +
  `aria-[current=page]:font-bold aria-[current=page]:text-accent-ink ${FOCUS}`;

/**
 * The phone shell: identity and account at the top, the everyday destinations
 * along the bottom, and the complete navigation behind "More".
 *
 * The bottom bar carries only permitted everyday destinations — never an
 * invented one, never a disabled one — and "More" opens the same grouped list
 * the desktop sidebar draws, from the same permitted set. A destination missing
 * from the bar is one press further away, not gone.
 *
 * The account button is not an account menu. It opens the navigation sheet,
 * which is where the name, the role label, and sign out live; there is no
 * profile screen and this does not pretend there is one.
 */
export function MobileChrome({
  everyday,
  current,
  onSelect,
  onOpenPanel,
  panelOpen,
  children,
}: {
  everyday: readonly NavigationItem[];
  current: View;
  onSelect: (view: View) => void;
  onOpenPanel: () => void;
  panelOpen: boolean;
  children: ReactNode;
}) {
  const t = useTranslator();
  const user = useAuthenticatedUser();

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
        <Brand variant="wordmark" />

        <button
          type="button"
          className={ACCOUNT_BUTTON}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          onClick={onOpenPanel}
        >
          <span className="truncate">{user.displayName}</span>
          <span className="sr-only">{t('nav.account')}</span>
          <span aria-hidden="true" className="text-ink-muted">
            ▾
          </span>
        </button>
      </div>

      {children}

      <nav
        aria-label={t('nav.everyday')}
        className="sticky bottom-0 z-10 flex border-t border-line bg-surface"
      >
        {everyday.map((item) => (
          <button
            key={item.view}
            type="button"
            className={TAB}
            aria-current={item.view === current ? 'page' : undefined}
            onClick={() => onSelect(item.view)}
          >
            {t(item.labelKey)}
          </button>
        ))}

        <button
          type="button"
          className={TAB}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          onClick={onOpenPanel}
        >
          {t('nav.more')}
        </button>
      </nav>
    </div>
  );
}
