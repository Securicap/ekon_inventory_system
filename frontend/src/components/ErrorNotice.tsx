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
      className="flex flex-col items-start gap-3 rounded-md border border-red-700 bg-red-50 px-4 py-3 text-red-900"
    >
      <p>{t(messageKeyForError(error))}</p>

      {requestId && <p className="text-sm text-red-800">{t('error.requestId', { requestId })}</p>}

      {onRetry && (
        <button type="button" className={SECONDARY_BUTTON} onClick={onRetry}>
          {t('action.retry')}
        </button>
      )}
    </div>
  );
}
