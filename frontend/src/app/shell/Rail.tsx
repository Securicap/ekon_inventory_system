import { useAuthenticatedUser } from '../../auth/useAuth.js';
import { useTranslator } from '../../i18n/index.js';
import type { NavigationItem, View } from '../navigation.js';
import { Brand } from './Brand.js';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus';

const ICON_BUTTON =
  `flex size-12 flex-none items-center justify-center rounded-md border border-line-strong ` +
  `bg-surface text-base font-semibold text-ink hover:bg-fill ${FOCUS}`;

/**
 * A rail entry is 56px tall and no wider than the rail. "Réception" does not
 * fit on one line at this width and is not asked to: it wraps, and the entry
 * grows downwards rather than out over the content.
 */
const RAIL_ITEM =
  `flex min-h-touch-lg w-full items-center justify-center rounded-md px-0.5 py-1.5 ` +
  `text-center text-[11px] leading-tight font-semibold text-ink wrap-anywhere hyphens-auto ` +
  `hover:bg-fill aria-[current=page]:bg-accent-soft aria-[current=page]:font-bold ` +
  `aria-[current=page]:text-accent-ink ${FOCUS}`;

/** "Marie Joseph" → "MJ". A mark for a 72px column, never a substitute for the name. */
function initials(displayName: string): string {
  const words = displayName.split(/\s+/).filter((word) => word.length > 0);
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

/**
 * The tablet shell: a 72px rail rather than a squeezed sidebar.
 *
 * A 248px column at 834px would take a third of the screen away from the
 * inventory table, and a table is what the tablet is for. So the rail keeps the
 * everyday destinations at a thumb-sized target and moves everything else —
 * every other permitted destination, the account, sign out — behind the menu
 * button, into the same sheet the phone opens. Nothing becomes unreachable;
 * it becomes one press away.
 */
export function Rail({
  everyday,
  current,
  onSelect,
  onOpenPanel,
  panelOpen,
}: {
  everyday: readonly NavigationItem[];
  current: View;
  onSelect: (view: View) => void;
  onOpenPanel: () => void;
  panelOpen: boolean;
}) {
  const t = useTranslator();
  const user = useAuthenticatedUser();

  return (
    <div className="flex w-18 flex-none flex-col items-center gap-4 border-r border-line bg-surface px-1 py-4">
      <Brand variant="compact" />

      <button
        type="button"
        className={ICON_BUTTON}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        onClick={onOpenPanel}
      >
        <span aria-hidden="true" className="flex flex-col gap-1">
          <span className="block h-0.5 w-4.5 bg-ink" />
          <span className="block h-0.5 w-4.5 bg-ink" />
          <span className="block h-0.5 w-4.5 bg-ink" />
        </span>
        <span className="sr-only">{t('nav.openNavigation')}</span>
      </button>

      <div className="h-px w-full bg-rule" />

      {everyday.length > 0 && (
        <nav aria-label={t('nav.everyday')} className="flex w-full flex-col items-center gap-1">
          {everyday.map((item) => (
            <button
              key={item.view}
              type="button"
              className={RAIL_ITEM}
              aria-current={item.view === current ? 'page' : undefined}
              onClick={() => onSelect(item.view)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>
      )}

      <div className="flex-1" />

      <button
        type="button"
        className={ICON_BUTTON}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        onClick={onOpenPanel}
      >
        <span aria-hidden="true">{initials(user.displayName)}</span>
        <span className="sr-only">{`${user.displayName} — ${t('nav.account')}`}</span>
      </button>
    </div>
  );
}
