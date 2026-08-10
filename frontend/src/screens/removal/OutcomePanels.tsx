import type { RemoveStockResponse } from '@ekon/shared';
import {
  DESTRUCTIVE_BUTTON,
  DESTRUCTIVE_BUTTON_BUSY,
  SECONDARY_BUTTON,
} from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import { messageKeyForError, requestIdForError } from '../../lib/errorMessages.js';

/**
 * The four things this screen can say once the command has been sent:
 * it worked, the shelf could not cover it, we do not know, and here is what you
 * can do about it.
 *
 * These are removal's own rather than receiving's, and the middle one is why.
 * Receiving has no equivalent of a shortfall — a delivery cannot be refused for
 * want of stock — so a shared "outcome panel" component would have to carry a
 * state one of its two callers can never reach, and would have to be told which
 * caller it belonged to in order to write `+12` or `−12`. That is a larger and
 * less truthful thing than the hundred lines of markup it would save.
 *
 * What *is* shared is everything that is genuinely generic: the tokens, the
 * button styles, `ErrorNotice`, and the error-to-sentence mapping.
 */

/**
 * What was recorded, in the terms the person used to record it.
 *
 * Two figures, and the distinction between them is the whole point. **Removed**
 * is the command — the number the employee typed and this browser sent, shown
 * back so they can see the movement was written as they meant it. **Remaining**
 * is the server's answer, `quantityAfter`, and is the only number here that
 * nobody in this browser could have known.
 *
 * There is no *before*. The response does not carry one, and reconstructing it
 * by adding the two figures together would print a quantity the server never
 * stated — arithmetic dressed as a fact, and wrong the moment somebody else at
 * the counter moved the same stock. The one that is missing is left out.
 *
 * Also deliberately absent: the movement id, the request hash, the negative
 * delta, the recorded time, the movement type, the actor. Those are how the
 * ledger keeps its own promises, and none of them is something an employee can
 * act on or should have to read.
 */
export function Confirmation({
  quantity,
  variantLabel,
  locationName,
  reasonLabel,
  result,
}: {
  quantity: number;
  variantLabel: string;
  locationName: string;
  reasonLabel: string;
  result: RemoveStockResponse;
}) {
  const t = useTranslator();

  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-x-6 gap-y-4 rounded-lg border border-success bg-success-soft p-5"
    >
      <div className="flex gap-6">
        <div>
          <p className="text-xs font-bold tracking-[0.08em] text-success uppercase">
            {t('removal.removedLabel')}
          </p>
          {/* A minus sign, not a hyphen, and part of the number rather than a
              colour: read aloud it is "minus six". */}
          <p className="tabular text-[44px] leading-none font-bold text-success-ink">
            {`−${quantity}`}
          </p>
        </div>

        <div className="border-l border-success/30 pl-6">
          <p className="text-xs font-bold tracking-[0.08em] text-success uppercase">
            {t('removal.remainingLabel')}
          </p>
          <p className="tabular text-[44px] leading-none font-bold text-success-ink">
            {result.quantityAfter}
          </p>
        </div>
      </div>

      <div className="min-w-60 flex-1">
        {/* Sentences, not a colour. Somebody who cannot tell green from grey
            reads exactly the same confirmation — and it is a confirmation:
            stock leaving is an ordinary thing for a shop to record, so a
            successful removal is not dressed as a warning. */}
        <p className="text-[17px] font-semibold text-success-ink">
          {t('removal.success', { quantity })}
        </p>
        <p className="mt-1 text-base text-success-ink">
          {t('removal.resultingQuantity', {
            location: locationName,
            quantity: result.quantityAfter,
          })}
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-sm text-success-ink">
          <dt className="opacity-80">{t('removal.variant')}</dt>
          <dd className="font-semibold">{variantLabel}</dd>
          <dt className="opacity-80">{t('removal.location')}</dt>
          <dd className="font-semibold">{locationName}</dd>
          <dt className="opacity-80">{t('removal.reason')}</dt>
          <dd className="font-semibold">{reasonLabel}</dd>
        </dl>
      </div>
    </div>
  );
}

/**
 * The shelf could not cover it.
 *
 * The state that belongs to removal and to nothing else, and the one most
 * easily rendered wrongly. It is **definitive**: the server took the row lock,
 * found the quantity short, and rolled the transaction back. No stock moved, no
 * movement was written, and sending the identical command again would be told
 * the identical thing. So it is a red refusal rather than an amber "we do not
 * know", and no resend is offered anywhere near it.
 *
 * Two sentences, because the second is an instruction rather than a fact: the
 * numbers have moved, they have just been read again, and the way forward is a
 * corrected removal — which is a different command, under a different operation
 * id. Nothing here invents an available quantity: what the shelf holds now is
 * whatever the refreshed balances say, and the form behind this says it.
 */
export function ShortfallNotice({ error }: { error: unknown }) {
  const t = useTranslator();
  const requestId = requestIdForError(error);

  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-lg border border-danger bg-danger-soft p-4.5"
    >
      <p className="text-xs font-bold tracking-[0.08em] text-danger uppercase">
        {t('removal.shortfallLabel')}
      </p>
      <p className="text-base font-semibold text-danger-ink">{t(messageKeyForError(error))}</p>
      <p className="text-[15px] text-pretty text-danger-ink">{t('removal.insufficientStock')}</p>
      {requestId !== null && (
        <p className="text-sm text-danger-ink">{t('error.requestId', { requestId })}</p>
      )}
    </div>
  );
}

/**
 * An answer that never arrived.
 *
 * A dropped connection and a server fault are the same fact to the person at
 * the counter: the stock may already be off the shelf. So this is not a red
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
        {t('removal.uncertainLabel')}
      </p>
      <p className="text-base font-semibold text-warning-ink">{t(messageKeyForError(error))}</p>
      <p className="text-[15px] text-pretty text-warning-ink">{t('removal.uncertainHint')}</p>
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
 * Resending the same removal and starting a different one are opposite acts:
 * the first is safe precisely because it is not new, and the second is only
 * safe once somebody has looked at what is actually on the shelf. Putting them
 * in one row of buttons would make the difference a matter of reading two
 * labels quickly, which is the thing that goes wrong in a hurry.
 *
 * A definitive refusal — a shortfall, a permission, a gone item, a changed
 * command — renders only the second block. The server has said something true,
 * and sending it again would hear it again.
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
        <div className="flex flex-col gap-2.5 rounded-lg border border-danger bg-surface p-4">
          <div>
            <p className="text-base font-semibold text-ink">{t('removal.retryTitle')}</p>
            <p className="mt-1 text-sm text-pretty text-ink-soft">{t('removal.retryExplain')}</p>
          </div>
          <div>
            {/* Busy, not unavailable, and still the colour of the act it
                repeats. While this is in flight the screen is doing the one
                thing this block promises — resending the saved removal — and
                greying it out would say the opposite. */}
            <button
              type="button"
              className={busy ? DESTRUCTIVE_BUTTON_BUSY : DESTRUCTIVE_BUTTON}
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
              {busy ? t('removal.retryingSame') : t('removal.retrySame')}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-4">
        <div>
          <p className="text-base font-semibold text-ink">{t('removal.startNewTitle')}</p>
          <p className="mt-1 text-sm text-pretty text-ink-soft">{t('removal.startNewExplain')}</p>
        </div>
        <div>
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onStartNew}>
            {t('removal.startNew')}
          </button>
        </div>
      </div>
    </div>
  );
}
