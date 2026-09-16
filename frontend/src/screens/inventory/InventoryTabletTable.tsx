import type { ReactNode } from 'react';
import type { VariantStockBalance } from '@ekon/shared';
import { useTranslator } from '../../i18n/index.js';
import { formatVariantAttributes } from '../../lib/variants.js';
import { LocationBreakdown } from './LocationBreakdown.js';
import { CELL, HEAD } from './tableStyles.js';

/**
 * Current stock on a tablet: still a table, with the three identity columns
 * folded into one.
 *
 * At 834px, after the 72px rail and the page padding, there is not room for
 * five columns without squeezing the shelf names and the SKU into two lines
 * each. The answer is not to give up the table — a tablet at a counter is
 * exactly where a register is read — it is to stop spending horizontal space on
 * separating three facts that identify the same thing.
 *
 * So Item carries the product name, the variant attributes, and the SKU stacked
 * in one cell, and the two columns that are actually being compared down the
 * page — where the stock is, and how much of it there is — keep their width.
 *
 * The stacked cell is the row's `<th scope="row">`, which makes it the row's
 * accessible name: a quantity in this table is announced with the product, the
 * variant, and the SKU it belongs to, which is more identity than the desktop
 * row header carries, not less.
 */
export function InventoryTabletTable({
  balances,
  renderActions,
}: {
  balances: readonly VariantStockBalance[];
  renderActions?: ((variant: VariantStockBalance) => ReactNode) | undefined;
}) {
  const t = useTranslator();

  return (
    <div className="rounded-lg border border-line bg-surface">
      <table className="w-full border-separate border-spacing-0 text-left">
        <thead>
          <tr>
            <th scope="col" className={`${HEAD} w-[44%]`}>
              {t('stock.columnItem')}
            </th>
            <th scope="col" className={`${HEAD} w-[38%]`}>
              {t('stock.columnLocations')}
            </th>
            <th scope="col" className={`${HEAD} w-[18%] text-right`}>
              {t('stock.total')}
            </th>
            {renderActions !== undefined && (
              <th scope="col" className={HEAD}>
                <span className="sr-only">{t('stock.columnActions')}</span>
              </th>
            )}
          </tr>
        </thead>

        <tbody>
          {balances.map((variant) => (
            <tr key={variant.variantId} className="last:[&>*]:border-b-0 hover:bg-canvas">
              <th scope="row" className={`${CELL} font-normal`}>
                <span className="block wrap-anywhere text-[15px] font-semibold text-ink">
                  {variant.productName}
                </span>

                <span
                  className={`block wrap-anywhere text-[15px] ${
                    variant.attributes.length > 0 ? 'text-ink-soft' : 'text-ink-muted'
                  }`}
                >
                  {variant.attributes.length > 0
                    ? formatVariantAttributes(variant.attributes)
                    : t('catalog.noAttributes')}
                </span>

                <span className="tabular block text-[13px] font-medium tracking-[0.02em] text-ink-soft">
                  {variant.sku}
                </span>
              </th>

              <td className={CELL}>
                <LocationBreakdown locations={variant.locations} />
              </td>

              <td className={`${CELL} tabular text-right text-base font-semibold text-ink`}>
                {variant.totalQuantity}
              </td>

              {renderActions !== undefined && <td className={CELL}>{renderActions(variant)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
