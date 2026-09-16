import type { ReactNode } from 'react';
import type { VariantStockBalance } from '@ekon/shared';
import { useTranslator } from '../../i18n/index.js';
import { formatVariantAttributes } from '../../lib/variants.js';
import { LocationBreakdown } from './LocationBreakdown.js';

/**
 * Current stock on a phone: the same register, reflowed.
 *
 * Not the table at 390px. Five columns on a phone means either scrolling
 * sideways to reach the quantity — the one thing anybody opened this screen
 * for — or squeezing the SKU onto two lines. So the columns become a stack: the
 * item at the top, its total under it, and the shelves under that.
 *
 * It stays a list rather than becoming cards. One rule between records is
 * enough to separate them; a bordered panel around every item would turn eight
 * items into eight screens of scrolling and say nothing the rule does not.
 *
 * The total keeps its own line with its label beside it, because the size and
 * the right edge that carry it on a laptop carry nothing to somebody listening
 * to the page.
 */
export function InventoryRecords({
  balances,
  renderActions,
}: {
  balances: readonly VariantStockBalance[];
  renderActions?: ((variant: VariantStockBalance) => ReactNode) | undefined;
}) {
  const t = useTranslator();

  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {balances.map((variant) => (
        <li key={variant.variantId} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="wrap-anywhere text-[17px] font-semibold text-ink">
              {variant.productName}
            </h2>

            <p
              className={`wrap-anywhere text-[15px] ${
                variant.attributes.length > 0 ? 'text-ink-soft' : 'text-ink-muted'
              }`}
            >
              {variant.attributes.length > 0
                ? formatVariantAttributes(variant.attributes)
                : t('catalog.noAttributes')}
            </p>

            <p className="tabular text-[13px] font-medium tracking-[0.02em] text-ink-soft">
              <span className="sr-only">{t('catalog.sku')} </span>
              {variant.sku}
            </p>
          </div>

          {/* Read as a sentence — "stock total, 24" — rather than as a large
              number somebody has to infer the meaning of from where it sits. */}
          <p className="flex items-baseline justify-between gap-4 border-t border-rule pt-2">
            <span className="text-xs font-bold tracking-[0.06em] text-ink-muted uppercase">
              {t('stock.total')}
            </span>
            <span className="tabular text-lg font-semibold text-ink">{variant.totalQuantity}</span>
          </p>

          <LocationBreakdown locations={variant.locations} />

          {/* Under the record on a phone, where a thumb reaches them without
              covering the number they are about. */}
          {renderActions !== undefined && renderActions(variant)}
        </li>
      ))}
    </ul>
  );
}
