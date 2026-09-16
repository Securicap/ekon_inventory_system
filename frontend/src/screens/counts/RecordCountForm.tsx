import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { CountRecord, ListInventoryBalancesResponse } from '@ekon/shared';
import type { ViewFocus } from '../../app/navigation.js';
import { useAuth } from '../../auth/useAuth.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { StatusChip } from '../../components/StatusChip.js';
import {
  FIELD_ERROR,
  FIELD_HINT,
  FIELD_LABEL,
  OUTCOME_FOCUS,
  PANEL,
  PRIMARY_BUTTON,
  PRIMARY_BUTTON_BUSY,
  SECONDARY_BUTTON,
  TEXT_INPUT,
} from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import { ApiError } from '../../lib/api.js';
import { localDateTimeToIso, toLocalDateTimeInputValue } from '../../lib/businessTime.js';
import { emptyCount, formatVariance, validateCountForm } from '../../lib/counts.js';
import type { RecordCountFieldErrors, RecordCountFormValues } from '../../lib/counts.js';
import { recordCount } from '../../lib/countsApi.js';
import { newOperationId } from '../../lib/operations.js';
import { formatVariantLabel } from '../../lib/variants.js';

/**
 * Recording what is physically on the shelf.
 *
 * **The form does not show what Ekon expects.** Not because this is a blind
 * count — blind counting is a post-OR1 workflow with locking and second counts
 * and none of that is here — but because a number printed next to the box you
 * are about to type in is an invitation to agree with it. Somebody who walks a
 * shelf, finds six, and sees `7` on the screen types 7 more often than they
 * should, and the discrepancy that would have told the shop something
 * disappears.
 *
 * The comparison comes **after** submission, from the server, which is also the
 * only place it can honestly come from: the expected quantity is read inside
 * the recording transaction and this form never has it.
 *
 * And the sentence above the fields is not decoration. *This does not change
 * stock* is the single most important thing a person can know before entering a
 * count, because every other inventory screen they have used does change it.
 */
export function RecordCountForm({
  balances,
  focus,
  recorded,
  onRecorded,
  onDismiss,
}: {
  balances: ListInventoryBalancesResponse;
  /** Prefilled when this screen was opened from an inventory row. */
  focus: ViewFocus | null;
  /** The observation just recorded, if there is one on screen. */
  recorded: CountRecord | null;
  onRecorded: (count: CountRecord) => void;
  onDismiss: () => void;
}) {
  const t = useTranslator();
  const { reportSessionEnded } = useAuth();

  /**
   * The id of the observation being entered, generated when the form opens and
   * reused for every retry — the same rule receiving follows, and for the same
   * reason. A count posts no movement, but a duplicate is a second record of
   * one shelf-check, and either of the two could later be reconciled.
   */
  const [operationId, setOperationId] = useState(newOperationId);
  const [values, setValues] = useState<RecordCountFormValues>(() => ({
    ...emptyCount(toLocalDateTimeInputValue(new Date())),
    variantId: focus?.variantId ?? '',
    locationId: focus?.locationId ?? '',
  }));
  const [fieldErrors, setFieldErrors] = useState<RecordCountFieldErrors>({});

  const submit = useMutation({
    mutationFn: (request: Parameters<typeof recordCount>[0]) => recordCount(request),
    onSuccess: (count) => {
      onRecorded(count);
      // A fresh identity for the next shelf. The observation just recorded is
      // settled, so nothing about it needs the old id any more.
      setOperationId(newOperationId());
      setValues((current) => ({ ...current, variantId: '', countedQuantity: '' }));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) reportSessionEnded();
    },
  });

  const locations = new Map<string, string>();
  for (const variant of balances) {
    for (const location of variant.locations) {
      locations.set(location.locationId, location.locationName);
    }
  }

  function update(next: Partial<RecordCountFormValues>): void {
    setValues((current) => ({ ...current, ...next }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (submit.isPending) return;

    const errors = validateCountForm(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const countedAt = localDateTimeToIso(values.countedAtLocal);
    if (countedAt === null) return;

    setFieldErrors({});
    submit.mutate({
      operationId,
      variantId: values.variantId,
      locationId: values.locationId,
      countedQuantity: Number(values.countedQuantity),
      countedAt,
    });
  }

  return (
    <section className={`${PANEL} flex flex-col gap-4`} aria-labelledby="counts-record">
      <div>
        <h2 id="counts-record" className="text-lg font-semibold text-ink">
          {t('counts.recordTitle')}
        </h2>
        {/* The sentence that keeps the workflow honest. */}
        <p className="mt-1 text-[15px] text-pretty text-ink-soft">{t('counts.recordExplains')}</p>
      </div>

      {recorded !== null && <CountOutcome count={recorded} onDismiss={onDismiss} />}

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label htmlFor="count-item" className={FIELD_LABEL}>
              {t('counts.item')}
            </label>
            <select
              id="count-item"
              className={TEXT_INPUT}
              value={values.variantId}
              aria-invalid={fieldErrors.variantId !== undefined}
              onChange={(event) => update({ variantId: event.target.value })}
            >
              <option value="">{t('counts.choose')}</option>
              {balances.map((variant) => (
                <option key={variant.variantId} value={variant.variantId}>
                  {formatVariantLabel(variant.productName, variant.attributes, variant.sku)}
                </option>
              ))}
            </select>
            {fieldErrors.variantId && <p className={FIELD_ERROR}>{t(fieldErrors.variantId)}</p>}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="count-location" className={FIELD_LABEL}>
              {t('counts.location')}
            </label>
            <select
              id="count-location"
              className={TEXT_INPUT}
              value={values.locationId}
              aria-invalid={fieldErrors.locationId !== undefined}
              onChange={(event) => update({ locationId: event.target.value })}
            >
              <option value="">{t('counts.choose')}</option>
              {[...locations].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            {fieldErrors.locationId && <p className={FIELD_ERROR}>{t(fieldErrors.locationId)}</p>}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="count-quantity" className={FIELD_LABEL}>
              {t('counts.counted')}
            </label>
            <input
              id="count-quantity"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              className={TEXT_INPUT}
              value={values.countedQuantity}
              aria-invalid={fieldErrors.countedQuantity !== undefined}
              onChange={(event) => update({ countedQuantity: event.target.value })}
            />
            {/* Zero is a real observation and the hint says so, because a form
                that looks like it wants a positive number is a form somebody
                skips when the shelf is empty — which is the count that matters
                most. */}
            <p className={FIELD_HINT}>{t('counts.countedHint')}</p>
            {fieldErrors.countedQuantity && (
              <p className={FIELD_ERROR}>{t(fieldErrors.countedQuantity)}</p>
            )}
          </div>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <label htmlFor="count-time" className={FIELD_LABEL}>
              {t('counts.countedAt')}
            </label>
            <input
              id="count-time"
              type="datetime-local"
              className={TEXT_INPUT}
              value={values.countedAtLocal}
              aria-invalid={fieldErrors.countedAtLocal !== undefined}
              onChange={(event) => update({ countedAtLocal: event.target.value })}
            />
            <p className={FIELD_HINT}>{t('counts.countedAtHint')}</p>
            {fieldErrors.countedAtLocal && (
              <p className={FIELD_ERROR}>{t(fieldErrors.countedAtLocal)}</p>
            )}
          </div>
        </div>

        {submit.isError && <ErrorNotice error={submit.error} />}

        <div>
          <button
            type="submit"
            className={submit.isPending ? PRIMARY_BUTTON_BUSY : PRIMARY_BUTTON}
            disabled={balances.length === 0}
          >
            {submit.isPending ? t('status.sending') : t('counts.record')}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * What the count turned out to be — the comparison the form deliberately did
 * not show beforehand.
 *
 * A match is a complete answer and says so. A difference is not: it says what
 * was expected, what was seen, and that somebody needs to look at it. Neither
 * offers to fix anything from here, because accepting a difference is a
 * decision taken against the list below with a reason attached.
 */
function CountOutcome({ count, onDismiss }: { count: CountRecord; onDismiss: () => void }) {
  const t = useTranslator();
  const matched = count.variance === 0;

  return (
    <div
      role="status"
      tabIndex={-1}
      className={`flex flex-col gap-2 rounded-md border px-3.5 py-3 ${OUTCOME_FOCUS} ${
        matched ? 'border-success bg-success-soft' : 'border-warning bg-warning-soft'
      }`}
    >
      <p className="font-semibold text-ink">
        {formatVariantLabel(count.variant.productName, count.variant.attributes, count.variant.sku)}
      </p>

      <dl className="tabular grid grid-cols-[auto_1fr] gap-x-4 text-[15px]">
        <dt className="text-ink-soft">{t('counts.expected')}</dt>
        <dd className="text-ink">{count.expectedQuantity}</dd>
        <dt className="text-ink-soft">{t('counts.counted')}</dt>
        <dd className="text-ink">{count.countedQuantity}</dd>
        <dt className="text-ink-soft">{t('counts.difference')}</dt>
        <dd className="font-semibold text-ink">{formatVariance(count.variance)}</dd>
      </dl>

      <p className="flex items-center gap-2">
        <StatusChip
          label={t(matched ? 'counts.statusMatched' : 'counts.needsReview')}
          tone={matched ? 'positive' : 'attention'}
        />
      </p>

      <div>
        <button type="button" className={SECONDARY_BUTTON} onClick={onDismiss}>
          {t('counts.recordAnother')}
        </button>
      </div>
    </div>
  );
}
