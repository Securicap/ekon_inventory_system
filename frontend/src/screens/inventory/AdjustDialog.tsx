import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ADJUSTMENT_REASONS, type VariantStockBalance } from '@ekon/shared';
import { useAuth } from '../../auth/useAuth.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { FIELD_ERROR, FIELD_HINT, FIELD_LABEL, TEXT_INPUT } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import { ApiError } from '../../lib/api.js';
import {
  ADJUSTMENT_DIRECTION_KEYS,
  ADJUSTMENT_REASON_KEYS,
  emptyAdjustment,
  toQuantityDelta,
  validateAdjustmentForm,
  type AdjustmentFieldErrors,
  type AdjustmentFormValues,
} from '../../lib/adjustment.js';
import { adjustStock } from '../../lib/adjustmentApi.js';
import { localDateTimeToIso, toLocalDateTimeInputValue } from '../../lib/businessTime.js';
import { inventoryBalancesQueryKey } from '../../lib/inventoryQueries.js';
import { movementsQueryPrefix } from '../../lib/movementsApi.js';
import { newOperationId } from '../../lib/operations.js';
import { formatVariantLabel } from '../../lib/variants.js';

/**
 * Correcting a quantity Ekon has wrong.
 *
 * **This is not Remove, and the dialog works hard to say so.** Removing stock
 * records that units left the shelf — sold, broken, taken for the shop's own
 * use. Adjusting records that nothing happened at all and the *number* was
 * wrong: a delivery entered twice, a sale rung up while the system was down, a
 * mis-keyed receipt. They move the same stock and mean opposite things in a
 * history, permanently, which is why they are different capabilities and why
 * this is a small dialog attached to the row whose number is wrong rather than
 * a third entry in the navigation beside Receive and Remove.
 *
 * It is also not a count. A count observes the shelf and leaves evidence; an
 * adjustment states a correction with no observation necessarily behind it. If
 * somebody walked the shelf and found six, the honest workflow is Counts.
 *
 * **Nobody types a minus sign.** The form asks which way and how many, and
 * `lib/adjustment.ts` turns the pair into the signed delta the contract wants.
 * The sentence above the button then says exactly what will be sent, so the
 * translation from "fewer by three" to `-3` happens in front of the person
 * rather than behind them.
 */
export function AdjustDialog({
  variant,
  initialLocationId,
  onDone,
  onCancel,
}: {
  variant: VariantStockBalance;
  /**
   * The shelf the row suggested. Changeable inside the dialog, because a
   * correction is per (item, shelf) and the row that was clicked is a starting
   * point rather than a decision — the number that is wrong may be the back
   * room's rather than the counter's.
   */
  initialLocationId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslator();
  const { reportSessionEnded } = useAuth();
  const queryClient = useQueryClient();

  /** One correction, one id, reused by every retry of it. */
  const [operationId] = useState(newOperationId);
  const [values, setValues] = useState<AdjustmentFormValues>(() =>
    emptyAdjustment(toLocalDateTimeInputValue(new Date())),
  );
  const [locationId, setLocationId] = useState(initialLocationId);
  const [fieldErrors, setFieldErrors] = useState<AdjustmentFieldErrors>({});

  const location = variant.locations.find((candidate) => candidate.locationId === locationId);
  const delta = toQuantityDelta(values);

  const submit = useMutation({
    mutationFn: adjustStock,
    onSuccess: () => {
      /**
       * A correction is a movement, so the shelf and the ledger both changed.
       * Counts are untouched: an adjustment observes nothing and settles
       * nothing, and a count somebody recorded this morning still says what it
       * said.
       */
      void queryClient.invalidateQueries({ queryKey: inventoryBalancesQueryKey }).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: movementsQueryPrefix }).catch(() => {});
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) reportSessionEnded();
    },
  });

  function confirm(): void {
    const errors = validateAdjustmentForm(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const occurredAt = localDateTimeToIso(values.occurredAtLocal);
    const quantityDelta = toQuantityDelta(values);
    if (occurredAt === null || quantityDelta === null || values.reason === '') return;

    setFieldErrors({});
    submit.mutate({
      operationId,
      variantId: variant.variantId,
      locationId,
      quantityDelta,
      reason: values.reason,
      ...(values.note.trim() === '' ? {} : { note: values.note.trim() }),
      occurredAt,
    });
  }

  return (
    <ConfirmDialog
      title={t('adjust.title')}
      confirmLabel={t('adjust.confirm')}
      busy={submit.isPending}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      <dl className="tabular grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line bg-canvas px-3 py-2 text-sm">
        <dt className="text-ink-soft">{t('counts.item')}</dt>
        <dd className="text-ink">
          {formatVariantLabel(variant.productName, variant.attributes, variant.sku)}
        </dd>
        <dt className="text-ink-soft">{t('adjust.recorded')}</dt>
        <dd className="text-ink">{location?.quantity ?? 0}</dd>
      </dl>

      {/* The sentence that keeps this apart from Remove. */}
      <p className="text-pretty">{t('adjust.explains')}</p>

      <div className="flex flex-col gap-1">
        <label htmlFor="adjust-location" className={FIELD_LABEL}>
          {t('counts.location')}
        </label>
        <select
          id="adjust-location"
          className={TEXT_INPUT}
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
        >
          {variant.locations.map((candidate) => (
            <option key={candidate.locationId} value={candidate.locationId}>
              {candidate.locationName}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="adjust-direction" className={FIELD_LABEL}>
            {t('adjust.direction')}
          </label>
          <select
            id="adjust-direction"
            className={TEXT_INPUT}
            value={values.direction}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                direction: event.target.value as AdjustmentFormValues['direction'],
              }))
            }
          >
            {(['increase', 'decrease'] as const).map((direction) => (
              <option key={direction} value={direction}>
                {t(ADJUSTMENT_DIRECTION_KEYS[direction])}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="adjust-quantity" className={FIELD_LABEL}>
            {t('adjust.quantity')}
          </label>
          <input
            id="adjust-quantity"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            className={TEXT_INPUT}
            value={values.quantity}
            aria-invalid={fieldErrors.quantity !== undefined}
            onChange={(event) =>
              setValues((current) => ({ ...current, quantity: event.target.value }))
            }
          />
          {fieldErrors.quantity && <p className={FIELD_ERROR}>{t(fieldErrors.quantity)}</p>}
        </div>
      </div>

      {/* What will actually be sent, in the shop's words and in the ledger's
          arithmetic, before anybody agrees to it. */}
      {delta !== null && (
        <p aria-live="polite" className="text-pretty font-semibold">
          {t('adjust.willApply', { delta: delta > 0 ? `+${delta}` : `−${Math.abs(delta)}` })}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="adjust-reason" className={FIELD_LABEL}>
          {t('adjust.reason')}
        </label>
        <select
          id="adjust-reason"
          className={TEXT_INPUT}
          value={values.reason}
          aria-invalid={fieldErrors.reason !== undefined}
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              reason: event.target.value as AdjustmentFormValues['reason'],
            }))
          }
        >
          <option value="">{t('counts.choose')}</option>
          {ADJUSTMENT_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {t(ADJUSTMENT_REASON_KEYS[reason])}
            </option>
          ))}
        </select>
        {fieldErrors.reason && <p className={FIELD_ERROR}>{t(fieldErrors.reason)}</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="adjust-note" className={FIELD_LABEL}>
          {t('adjust.note')}
        </label>
        <input
          id="adjust-note"
          type="text"
          className={TEXT_INPUT}
          value={values.note}
          maxLength={500}
          aria-invalid={fieldErrors.note !== undefined}
          onChange={(event) => setValues((current) => ({ ...current, note: event.target.value }))}
        />
        <p className={FIELD_HINT}>{t('adjust.noteHint')}</p>
        {fieldErrors.note && <p className={FIELD_ERROR}>{t(fieldErrors.note)}</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="adjust-time" className={FIELD_LABEL}>
          {t('adjust.time')}
        </label>
        <input
          id="adjust-time"
          type="datetime-local"
          className={TEXT_INPUT}
          value={values.occurredAtLocal}
          aria-invalid={fieldErrors.occurredAtLocal !== undefined}
          onChange={(event) =>
            setValues((current) => ({ ...current, occurredAtLocal: event.target.value }))
          }
        />
        {fieldErrors.occurredAtLocal && (
          <p className={FIELD_ERROR}>{t(fieldErrors.occurredAtLocal)}</p>
        )}
      </div>

      {/* Including the one refusal this form cannot predict: a decrease the
          shelf cannot absorb. */}
      {submit.isError && <ErrorNotice error={submit.error} />}
    </ConfirmDialog>
  );
}
