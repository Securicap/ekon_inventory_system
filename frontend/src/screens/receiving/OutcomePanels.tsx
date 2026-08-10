import type { ReceiveStockResponse } from '@ekon/shared';
import { PRIMARY_BUTTON, PRIMARY_BUTTON_BUSY, SECONDARY_BUTTON } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import { messageKeyForError, requestIdForError } from '../../lib/errorMessages.js';

/**
 * What was recorded, in the terms the person used to record it.
 *
 * The item, the place, how many, and what is on the shelf now — which is the
 * number they will be asked about, and which the *server* supplied. Nothing
 * here is added up in the browser. Deliberately absent: the movement id, the
 * request hash, the quantity before, the recorded time, the movement type.
 * Those are how the ledger keeps its own promises, and none of them is
 * something an employee can act on or should have to read.
 */
export function Confirmation({
  quantity,
  variantLabel,
  locationName,
  result,
}: {
  quantity: number;
  variantLabel: string;
  locationName: string;
  result: ReceiveStockResponse;
}) {
  const t = useTranslator();

  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-x-6 gap-y-3 rounded-lg border border-success bg-success-soft p-5"
    >
      <div>
        <p className="text-xs font-bold tracking-[0.08em] text-success uppercase">
          {t('receiving.savedLabel')}
        </p>
        <p className="tabular text-[44px] leading-none font-bold text-success-ink">{`+${quantity}`}</p>
      </div>

      <div className="min-w-60 flex-1">
        {/* Sentences, not a colour. Somebody who cannot tell green from grey
            reads exactly the same confirmation. */}
        <p className="text-[17px] font-semibold text-success-ink">
          {t('receiving.success', { quantity })}
        </p>
        <p className="mt-1 text-base text-success-ink">
          {t('receiving.resultingQuantity', {
            location: locationName,
            quantity: result.quantityAfter,
          })}
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-sm text-success-ink">
          <dt className="opacity-80">{t('receiving.variant')}</dt>
          <dd className="font-semibold">{variantLabel}</dd>
          <dt className="opacity-80">{t('receiving.location')}</dt>
          <dd className="font-semibold">{locationName}</dd>
        </dl>
      </div>
    </div>
  );
}

/**
 * An answer that never arrived.
 *
 * A dropped connection and a server fault are the same fact to the person at
 * the counter: the receipt may already be written. So this is not a red
 * failure — it is the honest "we do not know", and the two things that can be
 * done about it are offered as two separate blocks below it, never as two
 * buttons side by side.
 *
 * One `role="alert"`, carrying the same sentence and the same request id the
 * shared notice would have carried. Two live regions competing to be read is
 * how somebody misses the one that mattered.
 */
export function UncertainNotice({ error }: { error: unknown }) {
  const t = useTranslator();
  const requestId = requestIdForError(error);

  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-lg border border-warning bg-warning-soft p-4.5"
    >
      <p className="text-xs font-bold tracking-[0.08em] text-warning uppercase">
        {t('receiving.uncertainLabel')}
      </p>
      <p className="text-base font-semibold text-warning-ink">{t(messageKeyForError(error))}</p>
      <p className="text-[15px] text-pretty text-warning-ink">{t('receiving.uncertainHint')}</p>
      {requestId !== null && (
        <p className="text-sm text-warning-ink">{t('error.requestId', { requestId })}</p>
      )}
    </div>
  );
}

/**
 * The two ways out of a failed attempt, as two blocks that cannot be mistaken
 * for one another.
 *
 * Resending the same receipt and starting a different one are opposite acts:
 * the first is safe precisely because it is not new, and the second is only
 * safe once somebody has looked. Putting them in one row of buttons would make
 * the difference a matter of reading two labels quickly, which is the thing
 * that goes wrong in a hurry.
 *
 * A definitive refusal renders only the second block. The server has said
 * something true, and sending it again would hear it again.
 */
export function FailureActions({
  canRetry,
  busy,
  onRetry,
  onStartNew,
}: {
  canRetry: boolean;
  busy: boolean;
  onRetry: () => void;
  onStartNew: () => void;
}) {
  const t = useTranslator();

  return (
    <div className="flex flex-col gap-3">
      {canRetry && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-accent bg-surface p-4">
          <div>
            <p className="text-base font-semibold text-ink">{t('receiving.retryTitle')}</p>
            <p className="mt-1 text-sm text-pretty text-ink-soft">{t('receiving.retryExplain')}</p>
          </div>
          <div>
            {/* Busy, not unavailable. While this is in flight the screen is
                doing the one thing this block promises — resending the saved
                receipt — and greying it out would say the opposite. */}
            <button
              type="button"
              className={busy ? PRIMARY_BUTTON_BUSY : PRIMARY_BUTTON}
              disabled={busy}
              aria-busy={busy}
              onClick={onRetry}
            >
              {busy && (
                <span
                  aria-hidden="true"
                  className="mr-2.5 inline-block size-3.5 animate-spin rounded-full border-2 border-white/45 border-t-white motion-reduce:animate-none"
                />
              )}
              {busy ? t('receiving.retryingSame') : t('receiving.retrySame')}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-4">
        <div>
          <p className="text-base font-semibold text-ink">{t('receiving.startNewTitle')}</p>
          <p className="mt-1 text-sm text-pretty text-ink-soft">{t('receiving.startNewExplain')}</p>
        </div>
        <div>
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onStartNew}>
            {t('receiving.startNew')}
          </button>
        </div>
      </div>
    </div>
  );
}
