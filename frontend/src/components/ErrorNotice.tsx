import { useTranslator } from '../i18n/index.js';
import { messageKeyForError, requestIdForError } from '../lib/errorMessages.js';
import { SECONDARY_BUTTON } from './styles.js';

/**
 * A failure, said once, in the reader's language, with the request id when the
 * server gave us one.
 *
 * `role="alert"` rather than colour alone: the message is a sentence, the
 * border and the icon-free layout are decoration, and somebody who cannot
 * distinguish red from grey reads exactly the same thing.
 */
export function ErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
}) {
  const t = useTranslator();
  const requestId = requestIdForError(error);

  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-md border border-danger bg-danger-soft px-3.5 py-3 text-[15px] text-danger-ink"
    >
      <p className="font-semibold">{t(messageKeyForError(error))}</p>

      {requestId && <p className="text-sm">{t('error.requestId', { requestId })}</p>}

      {onRetry && (
        <button type="button" className={SECONDARY_BUTTON} onClick={onRetry}>
          {t('action.retry')}
        </button>
      )}
    </div>
  );
}
