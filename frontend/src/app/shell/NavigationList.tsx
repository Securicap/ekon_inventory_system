import { NAV_ITEM } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import type { NavigationGroup, View } from '../navigation.js';

/**
 * The grouped list of destinations, drawn the same way wherever it appears.
 *
 * The desktop sidebar and the mobile navigation panel both render this, over
 * the same groups, so "what may this person open, and under which heading" is
 * answered once. They differ in one thing — how tall an entry is, because a
 * thumb needs more than a mouse — and that is the whole of the difference.
 *
 * Each group is a real list, named by its caption through `aria-labelledby`
 * rather than by a heading: the caption is a label for a list, not a section of
 * the document, and the page's outline belongs to the screen in `main`.
 */
export function NavigationList({
  groups,
  current,
  onSelect,
  size,
}: {
  groups: readonly NavigationGroup[];
  current: View;
  onSelect: (view: View) => void;
  /** `pointer` for a mouse-driven sidebar, `touch` for a panel under a thumb. */
  size: 'pointer' | 'touch';
}) {
  const t = useTranslator();
  const height = size === 'touch' ? 'min-h-touch-lg text-[17px]' : 'min-h-touch';

  return (
    <nav aria-label={t('nav.main')} className="flex flex-col">
      {groups.map((group, index) => (
        <div key={group.id} className={index === 0 ? undefined : 'pt-4'}>
          <p
            id={`nav-group-${group.id}`}
            className="px-2.5 pb-1.5 text-xs font-bold tracking-[0.1em] text-ink-muted uppercase"
          >
            {t(group.labelKey)}
          </p>

          <ul aria-labelledby={`nav-group-${group.id}`} className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <li key={item.view}>
                <button
                  type="button"
                  className={`${NAV_ITEM} ${height}`}
                  aria-current={item.view === current ? 'page' : undefined}
                  onClick={() => onSelect(item.view)}
                >
                  {t(item.labelKey)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
