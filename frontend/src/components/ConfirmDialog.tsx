import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslator } from '../i18n/index.js';
import {
  DESTRUCTIVE_BUTTON,
  DESTRUCTIVE_BUTTON_BUSY,
  PRIMARY_BUTTON,
  PRIMARY_BUTTON_BUSY,
  SECONDARY_BUTTON,
} from './styles.js';

/**
 * The one dialog this application has: a deliberate yes to something that
 * changes stock or withdraws merchandise.
 *
 * It exists because `window.confirm` cannot say enough. Archiving, reversing a
 * movement, and accepting a count difference each need a sentence naming *what
 * will actually happen* — "this will adjust inventory by −1", not "are you
 * sure?" — and some of them need a field as well. A native confirm can carry
 * neither, cannot be translated, and looks like the browser rather than like
 * the application.
 *
 * It is deliberately **not** used for Receive and Remove. Those are the
 * high-frequency acts of a shift, both are already a filled-in form somebody
 * pressed a button on, and both are correctable afterwards; a confirmation step
 * on either would be friction that teaches people to click through
 * confirmations.
 *
 * Accessibility is the whole implementation, and there is not much else to it:
 *
 *  - `role="dialog"` with `aria-modal`, titled by its own heading;
 *  - focus moves in on open and returns to whatever opened it on close, so
 *    somebody on a keyboard is not dropped at the top of the page;
 *  - `Escape` closes, and the backdrop is a button so a pointer can too;
 *  - focus is trapped between the first and last control, because a dialog you
 *    can Tab out of is a dialog a screen reader will read the page behind.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  tone = 'primary',
  confirmDisabled = false,
  children,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The command is in flight: the dialog stays, and says so. */
  busy?: boolean;
  /**
   * `danger` for the two that take stock off a shelf or withdraw merchandise —
   * reversal and archiving. Colour is the second signal; the sentence in the
   * body is the first.
   */
  tone?: 'primary' | 'danger';
  /** A required field inside the dialog has not been filled in yet. */
  confirmDisabled?: boolean;
  /** The sentence, and any field the decision needs. */
  children: ReactNode;
}) {
  const t = useTranslator();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    // The first control inside, so a keyboard lands on the decision rather than
    // on the heading above it.
    const focusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();

    return () => {
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;

    const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const confirmClass =
    tone === 'danger'
      ? busy
        ? DESTRUCTIVE_BUTTON_BUSY
        : DESTRUCTIVE_BUTTON
      : busy
        ? PRIMARY_BUTTON_BUSY
        : PRIMARY_BUTTON;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      {/* A real button rather than a div with a click handler: it is a control,
          it is reachable, and it says what it does to anybody who cannot see
          that the page behind has dimmed. */}
      <button
        type="button"
        className="absolute inset-0 bg-ink/40"
        aria-label={t('action.cancel')}
        onClick={onCancel}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onKeyDown={onKeyDown}
        /* Full width at the bottom of a phone, a centred panel anywhere else.
           The max height and inner scroll are what keep a dialog with a reason
           list and a note field usable on a 390px screen. */
        className="relative flex max-h-[92vh] w-full max-w-[520px] flex-col gap-4 overflow-y-auto rounded-t-xl border border-line bg-surface p-5 sm:rounded-xl"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-ink">
          {title}
        </h2>

        <div className="flex flex-col gap-3 text-[15px] text-ink">{children}</div>

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onCancel} disabled={busy}>
            {t('action.cancel')}
          </button>
          <button
            type="button"
            className={confirmClass}
            onClick={onConfirm}
            disabled={confirmDisabled || busy}
          >
            {busy ? t('status.sending') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]';
