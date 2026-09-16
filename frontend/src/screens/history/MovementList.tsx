import type { InventoryMovementRecord } from '@ekon/shared';
import { StatusChip } from '../../components/StatusChip.js';
import { SECONDARY_BUTTON } from '../../components/styles.js';
import { formatShopTime, useTranslator } from '../../i18n/index.js';
import { formatDelta, isReversible, movementHeadlineKey, reasonKey } from '../../lib/movements.js';
import { formatVariantAttributes } from '../../lib/variants.js';

/**
 * The ledger, read as records rather than as a table.
 *
 * A movement is six facts that belong together — what, where, which way, from
 * what to what, why, and who — and on a phone a six-column table is either a
 * sideways scroll or six illegible columns. So it is one record per movement at
 * every width, with the columns becoming rows as the screen narrows. The
 * desktop version is the same markup with the parts laid out across.
 *
 * **`before → after` is shown, not just the delta.** The delta says what
 * changed; the pair says what the shelf held on either side of it, which is
 * what somebody reconstructing a discrepancy actually needs. Both come from the
 * ledger row and neither is computed here — the arithmetic was settled when the
 * movement was posted, and recomputing it in a browser would be inventing a
 * second answer.
 */
export function MovementList({
  movements,
  onReverse,
}: {
  movements: readonly InventoryMovementRecord[];
  /** Absent for somebody without `inventory.reverse`: no button, not a disabled one. */
  onReverse?: ((movement: InventoryMovementRecord) => void) | undefined;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {movements.map((movement) => (
        <MovementRecord key={movement.id} movement={movement} onReverse={onReverse} />
      ))}
    </ul>
  );
}

function MovementRecord({
  movement,
  onReverse,
}: {
  movement: InventoryMovementRecord;
  onReverse?: ((movement: InventoryMovementRecord) => void) | undefined;
}) {
  const t = useTranslator();
  const reason = reasonKey(movement.reasonCode);
  const attributes = formatVariantAttributes(movement.variant.attributes);
  const reversible = isReversible(movement);

  return (
    <li className="flex flex-col gap-2 px-4 py-3 lg:flex-row lg:items-start lg:gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-ink">
          {movement.variant.brandName !== null && (
            <span className="text-ink-soft">{movement.variant.brandName} · </span>
          )}
          {movement.variant.productName}
        </p>

        <p className="text-sm text-ink-soft">
          {attributes !== '' && <span>{attributes} · </span>}
          <span className="tabular tracking-[0.02em]">{movement.variant.sku}</span>
          <span> · {movement.location.name}</span>
        </p>

        {/* The relationship badges, when there is one. They are evidence links
            in words rather than ids: "Reversed" is what somebody needs to see
            on a receipt that was undone, and the id it points at belongs in a
            support conversation rather than in a feed. */}
        {(movement.reversedByMovementId !== null ||
          movement.reversesMovementId !== null ||
          movement.countId !== null) && (
          <p className="mt-1.5 flex flex-wrap gap-1.5">
            {movement.reversedByMovementId !== null && (
              <StatusChip label={t('history.wasReversed')} tone="attention" />
            )}
            {movement.reversesMovementId !== null && (
              <StatusChip label={t('history.isReversal')} tone="neutral" />
            )}
            {movement.countId !== null && (
              <StatusChip label={t('history.fromCount')} tone="neutral" />
            )}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 lg:w-[34%] lg:flex-col lg:items-end lg:gap-1">
        {/* What kind of change, in the shop's words. An `ISSUE` leads with its
            reason — "Sold" — because that is the business fact; everything else
            leads with its type. */}
        <span className="text-[15px] font-semibold text-ink">
          {t(movementHeadlineKey(movement))}
        </span>

        <span
          className={`tabular text-[17px] font-semibold ${
            movement.quantityDelta > 0 ? 'text-success-ink' : 'text-danger-ink'
          }`}
        >
          {formatDelta(movement.quantityDelta)}
        </span>

        <span className="tabular text-sm text-ink-soft">
          {movement.quantityBefore} → {movement.quantityAfter}
        </span>
      </div>

      <div className="flex flex-col gap-1 text-sm text-ink-soft lg:w-[26%] lg:items-end">
        <span className="tabular">{formatShopTime(movement.recordedAt)}</span>
        <span>{movement.actor.displayName ?? t('history.unknownActor')}</span>

        {/* The reason again, spelled out, for the types whose headline is their
            movement type. A sale already said "Sold" above and does not say it
            twice. */}
        {reason !== null && movement.movementType !== 'ISSUE' && <span>{t(reason)}</span>}

        {movement.note !== null && <span className="text-pretty">{movement.note}</span>}

        {onReverse !== undefined && reversible && (
          <button
            type="button"
            className={`${SECONDARY_BUTTON} mt-1`}
            onClick={() => onReverse(movement)}
          >
            {t('history.reverse')}
          </button>
        )}
      </div>
    </li>
  );
}
