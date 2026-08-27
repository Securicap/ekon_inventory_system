import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { COUNT_RECONCILIATION_REASONS, type CountRecord } from '@ekon/shared';
import { useAuth } from '../../auth/useAuth.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { FIELD_ERROR, FIELD_HINT, FIELD_LABEL, TEXT_INPUT } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import { ApiError } from '../../lib/api.js';
import {
  COUNT_REASON_KEYS,
  formatVariance,
  reconciliationMessageKey,
  validateReconcileForm,
  type ReconcileFieldErrors,
  type ReconcileFormValues,
} from '../../lib/counts.js';
import { reconcileCount } from '../../lib/countsApi.js';
import { newOperationId } from '../../lib/operations.js';
import { formatVariantLabel } from '../../lib/variants.js';

/**
 * Accepting a difference — the one act on the Counts screen that changes stock.
 *
 * The sentence in the middle of this dialog is the most carefully worded string
 * in the application, and it is worth saying why. It says:
 *
 * > This will adjust inventory by −1.
 *
 * and it must never say:
 *
 * > This will set inventory to 6.
 *
 * The second is what a reader assumes and it is **wrong**. Six was true when
 * the shelf was walked; if a unit sold in the hour since, the shelf now holds
 * five and accepting a difference of one leaves four. The server applies the
 * observed *difference* to the current balance — which is the only arithmetic
 * that keeps every legitimate movement posted in between — and a dialog that
 * promised a destination would be promising a number the system will not
 * produce.
 *
 * The reason is required because a stock change nobody explained is exactly
 * what the count principle exists to prevent, and `OTHER` demands a note
 * because it explains nothing on its own.
 */
export function ReconcileDialog({
  count,
  onDone,
  onCancel,
}: {
  count: CountRecord;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslator();
  const { reportSessionEnded } = useAuth();

  /** One decision, one id, reused by every retry of it. */
  const [operationId] = useState(newOperationId);
  const [values, setValues] = useState<ReconcileFormValues>({ reason: '', note: '' });
  const [fieldErrors, setFieldErrors] = useState<ReconcileFieldErrors>({});

  const submit = useMutation({
    mutationFn: (request: Parameters<typeof reconcileCount>[1]) =>
      reconcileCount(count.id, request),
    onSuccess: onDone,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) reportSessionEnded();
    },
  });

  function confirm(): void {
    const errors = validateReconcileForm(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    if (values.reason === '') return;

    setFieldErrors({});
    submit.mutate({
      operationId,
      reason: values.reason,
      ...(values.note.trim() === '' ? {} : { note: values.note.trim() }),
    });
  }

  return (
    <ConfirmDialog
      title={t('counts.reconcileTitle')}
      confirmLabel={t('counts.reconcileConfirm')}
      busy={submit.isPending}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      <dl className="tabular grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line bg-canvas px-3 py-2 text-sm">
        <dt className="text-ink-soft">{t('counts.item')}</dt>
        <dd className="text-ink">
          {formatVariantLabel(
            count.variant.productName,
            count.variant.attributes,
            count.variant.sku,
          )}
        </dd>
        <dt className="text-ink-soft">{t('counts.location')}</dt>
        <dd className="text-ink">{count.location.name}</dd>
        <dt className="text-ink-soft">{t('counts.expected')}</dt>
        <dd className="text-ink">{count.expectedQuantity}</dd>
        <dt className="text-ink-soft">{t('counts.counted')}</dt>
        <dd className="text-ink">{count.countedQuantity}</dd>
      </dl>

      {/* The delta, named as a change and never as a destination. */}
      <p className="text-pretty font-semibold">
        {t(reconciliationMessageKey(count), { delta: formatVariance(count.variance) })}
      </p>
      <p className="text-pretty text-sm text-ink-soft">{t('counts.reconcileExplains')}</p>

      <div className="flex flex-col gap-1">
        <label htmlFor="reconcile-reason" className={FIELD_LABEL}>
          {t('counts.reason')}
        </label>
        <select
          id="reconcile-reason"
          className={TEXT_INPUT}
          value={values.reason}
          aria-invalid={fieldErrors.reason !== undefined}
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              reason: event.target.value as ReconcileFormValues['reason'],
            }))
          }
        >
          <option value="">{t('counts.choose')}</option>
          {/* The vocabulary, translated for display and sent as the code. There
              is deliberately no "the count was wrong" here: a mistaken count is
              corrected by counting again, not by accepting a difference nobody
              believes in. */}
          {COUNT_RECONCILIATION_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {t(COUNT_REASON_KEYS[reason])}
            </option>
          ))}
        </select>
        {fieldErrors.reason && <p className={FIELD_ERROR}>{t(fieldErrors.reason)}</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="reconcile-note" className={FIELD_LABEL}>
          {t('counts.note')}
        </label>
        <input
          id="reconcile-note"
          type="text"
          className={TEXT_INPUT}
          value={values.note}
          maxLength={500}
          aria-invalid={fieldErrors.note !== undefined}
          onChange={(event) => setValues((current) => ({ ...current, note: event.target.value }))}
        />
        <p className={FIELD_HINT}>{t('counts.noteHint')}</p>
        {fieldErrors.note && <p className={FIELD_ERROR}>{t(fieldErrors.note)}</p>}
      </div>

      {/* The server's refusals, said as themselves: a difference somebody else
          already accepted, or a shelf that can no longer give the stock back. */}
      {submit.isError && <ErrorNotice error={submit.error} />}
    </ConfirmDialog>
  );
}
