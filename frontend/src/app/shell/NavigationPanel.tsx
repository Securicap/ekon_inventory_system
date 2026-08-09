import { useEffect, useRef, type KeyboardEvent } from 'react';
import { SECONDARY_BUTTON } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import type { NavigationGroup, View } from '../navigation.js';
import { Brand } from './Brand.js';
import { NavigationList } from './NavigationList.js';
import { UserArea } from './UserArea.js';

/**
 * The complete navigation, as a sheet over the page.
 *
 * This is what "More" opens on a phone and what the menu button opens on a
 * tablet, and it is the same grouped list the desktop sidebar draws, over the
 * same permitted destinations. The bottom bar carries the everyday few; this
 * carries all of them plus the account area, so nothing a person may open is
 * only reachable at one screen width.
 *
 * It behaves like a dialog because it is one: it takes focus when it opens,
 * keeps Tab inside itself while it is open, closes on Escape, and hands focus
 * back to the control that opened it. Every one of those is what somebody
 * without a mouse needs, and none of them needs a dependency.
 */
export function NavigationPanel({
  groups,
  current,
  onSelect,
  onClose,
}: {
  groups: readonly NavigationGroup[];
  current: View;
  onSelect: (view: View) => void;
  onClose: () => void;
}) {
  const t = useTranslator();
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  function keepFocusInside(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    // Every control in the sheet is a button; there is nothing else to reach.
    const focusable = [
      ...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []),
    ];
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      {/* Pressing beside the sheet closes it — the same escape a thumb expects. */}
      <div aria-hidden="true" className="fixed inset-0 z-40 bg-ink/40" onClick={onClose} />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.main')}
        onKeyDown={keepFocusInside}
        className="fixed inset-y-0 left-0 z-50 flex w-full max-w-[420px] flex-col bg-surface shadow-sheet"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <Brand variant="wordmark" />
          <button
            ref={closeButton}
            type="button"
            className={`${SECONDARY_BUTTON} px-3`}
            onClick={onClose}
          >
            {t('nav.close')}
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          <NavigationList groups={groups} current={current} onSelect={onSelect} size="touch" />
          <div className="flex-1" />
          <UserArea />
        </div>
      </div>
    </>
  );
}
