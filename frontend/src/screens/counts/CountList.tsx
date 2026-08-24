import type { CountRecord } from '@ekon/shared';
import { StatusChip, type ChipTone } from '../../components/StatusChip.js';
import { SECONDARY_BUTTON } from '../../components/styles.js';
import { formatShopTime, useTranslator } from '../../i18n/index.js';
import { COUNT_REASON_KEYS, COUNT_STATUS_KEYS, formatVariance } from '../../lib/counts.js';
import { formatVariantAttributes } from '../../lib/variants.js';

/**
 * What has been counted, and what still needs somebody to look at it.
 *
 * The three numbers are the record, and they are shown as the record: expected,
 * counted, difference — exactly as the server stored them when the shelf was
 * walked. **None of them is recomputed here.** A count taken last Tuesday says
 * what it said last Tuesday even though the shelf has moved since, because it
 * is evidence about a moment rather than a view of the present, and a list that
 * quietly re-derived the variance against today's balance would rewrite that
 * evidence every time the shop traded.
 *
 * The variance is emphasised and the screen is not. A discrepancy is worth
 * noticing, not worth alarming somebody about — a page of red would make the
 * one that matters harder to find, not easier.
 */
export function CountList({
  counts,
  onReconcile,
}: {
  counts: readonly CountRecord[];
  /** Absent without `inventory.count`: no button rather than a disabled one. */
  onReconcile?: ((count: CountRecord) => void) | undefined;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line">
      {counts.map((count) => (
        <CountRow key={count.id} count={count} onReconcile={onReconcile} />
      ))}
    </ul>
  );
}

const STATUS_TONES: Readonly<Record<CountRecord['status'], ChipTone>> = {
  MATCHED: 'positive',
  OPEN: 'attention',
  RECONCILED: 'neutral',
};

function CountRow({
  count,
  onReconcile,
}: {
  count: CountRecord;
  onReconcile?: ((count: CountRecord) => void) | undefined;
}) {
  const t = useTranslator();
  const attributes = formatVariantAttributes(count.variant.attributes);
  const reason = count.reconciliation?.reason;

  return (
    <li className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-start lg:gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-ink">
          {count.variant.brandName !== null && (
            <span className="text-ink-soft">{count.variant.brandName} · </span>
          )}
          {count.variant.productName}
        </p>
        <p className="text-sm text-ink-soft">
          {attributes !== '' && <span>{attributes} · </span>}
          <span className="tabular tracking-[0.02em]">{count.variant.sku}</span>
          <span> · {count.location.name}</span>
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          {t('counts.countedBy', {
            name: count.counter.displayName ?? t('history.unknownActor'),
            when: formatShopTime(count.countedAt),
          })}
        </p>
      </div>

      {/* The comparison, always in the same order and always aligned, so a
          column of them can be read down rather than one at a time. */}
      <dl className="tabular grid w-fit grid-cols-[auto_auto] gap-x-4 text-[15px] lg:w-[22%]">
        <dt className="text-ink-soft">{t('counts.expected')}</dt>
        <dd className="text-right text-ink">{count.expectedQuantity}</dd>
        <dt className="text-ink-soft">{t('counts.counted')}</dt>
        <dd className="text-right text-ink">{count.countedQuantity}</dd>
        <dt className="text-ink-soft">{t('counts.difference')}</dt>
        <dd
          className={`text-right font-semibold ${
            count.variance === 0
              ? 'text-ink'
              : count.variance > 0
                ? 'text-success-ink'
                : 'text-danger-ink'
          }`}
        >
          {formatVariance(count.variance)}
        </dd>
      </dl>

      <div className="flex flex-col items-start gap-2 lg:w-[26%] lg:items-end">
        <StatusChip label={t(COUNT_STATUS_KEYS[count.status])} tone={STATUS_TONES[count.status]} />

        {/* A settled difference says what was concluded and who concluded it.
            Without that, "Reconciled" is a state with no story behind it — and
            the story is the entire reason the reason code exists. */}
        {count.reconciliation !== null && reason !== undefined && (
          <div className="flex flex-col gap-0.5 text-sm text-ink-soft lg:items-end">
            <span>{t(COUNT_REASON_KEYS[reason])}</span>
            <span>{count.reconciliation.actor.displayName ?? t('history.unknownActor')}</span>
            {count.reconciliation.note !== null && (
              <span className="text-pretty">{count.reconciliation.note}</span>
            )}
          </div>
        )}

        {onReconcile !== undefined && count.status === 'OPEN' && (
          <button type="button" className={SECONDARY_BUTTON} onClick={() => onReconcile(count)}>
            {t('counts.reconcile')}
          </button>
        )}
      </div>
    </li>
  );
}
