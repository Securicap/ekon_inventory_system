import type { VariantStockBalance } from '@ekon/shared';
import { useTranslator } from '../../i18n/index.js';

/**
 * What somebody can do about one line of stock, offered on that line.
 *
 * Three actions at most and often fewer: see this item's history, count it,
 * correct its number. Each is gated on its own capability, and an action
 * somebody may not perform is **absent** rather than disabled — a greyed-out
 * button is a door with a lock on it, and this application does not show those.
 *
 * Receive and Remove are deliberately **not** here even though they would fit.
 * Both have their own destination, both are everyday work with their own form
 * and their own confirmation, and duplicating them onto every row would give
 * the same act two front doors that behave differently. What a row shortcut is
 * good for is the thing that is awkward from a destination: opening History
 * already filtered to this SKU, or counting the shelf you are looking at.
 *
 * The buttons are small and quiet on purpose. This is a reading screen with
 * actions on it, not an action screen — the numbers are what somebody came for.
 */
export function RowActions({
  variant,
  locationId,
  mayCount,
  mayAdjust,
  onHistory,
  onCount,
  onAdjust,
}: {
  variant: VariantStockBalance;
  /**
   * Which shelf the actions are about.
   *
   * Counting and adjusting are both per (item, location) — the ledger has no
   * notion of "this variant everywhere" — so a row that spans several locations
   * has to name one. The table passes the location whose cell the action sits
   * in; the records view passes the one the person chose.
   */
  locationId: string;
  mayCount: boolean;
  mayAdjust: boolean;
  onHistory: (variant: VariantStockBalance) => void;
  onCount: (variant: VariantStockBalance, locationId: string) => void;
  onAdjust: (variant: VariantStockBalance, locationId: string) => void;
}) {
  const t = useTranslator();

  return (
    <div className="flex flex-wrap gap-1">
      <RowAction label={t('stock.actionHistory')} onClick={() => onHistory(variant)} />
      {mayCount && (
        <RowAction label={t('stock.actionCount')} onClick={() => onCount(variant, locationId)} />
      )}
      {mayAdjust && (
        <RowAction label={t('stock.actionAdjust')} onClick={() => onAdjust(variant, locationId)} />
      )}
    </div>
  );
}

/**
 * One row action: a real button, at least 44px of target, and a visible focus
 * ring. Smaller than a `SECONDARY_BUTTON` because there may be three of them on
 * every row of a long table — but never smaller than a thumb.
 */
function RowAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-surface px-2.5 text-sm font-medium text-ink hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus"
    >
      {label}
    </button>
  );
}
