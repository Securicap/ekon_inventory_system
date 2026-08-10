import type { VariantStockBalance } from '@ekon/shared';
import { useTranslator } from '../../i18n/index.js';
import { formatVariantAttributes } from '../../lib/variants.js';
import { LocationBreakdown } from './LocationBreakdown.js';
import { CELL, HEAD } from './tableStyles.js';

/**
 * Current stock on a laptop: one row per variant, five columns, read top to
 * bottom.
 *
 * This is the densest screen in the application and it is meant to be. Somebody
 * at the counter is looking for one line in a list of everything the shop
 * stocks, and a page of cards makes them scroll past four items to see what a
 * table shows in one glance.
 *
 * **One row is one variant balance record**, because that is exactly what the
 * projection returns — a flat list of variants, each with its own locations and
 * its own total. A product with two sizes therefore appears twice in the
 * Product column. That repetition is deliberate: the alternative is a row span
 * over the product name, which stops being a grouping the moment a search
 * removes one of the two rows, and which has no counterpart in a response that
 * has no product grouping in it.
 *
 * The rows are not controls. There is no click, no menu, no checkbox, and
 * nothing here is editable — a balance is a projection of the ledger, and the
 * way to change it is to record a movement on the screen that exists for that.
 */
export function InventoryTable({ balances }: { balances: readonly VariantStockBalance[] }) {
  const t = useTranslator();

  return (
    /* No `overflow-hidden` on this panel, deliberately: a clipping ancestor
       silently disables `position: sticky` on the header inside it. The cells
       carry no background and no side borders, so the rounded corners need no
       clip to look right. */
    <div className="rounded-lg border border-line bg-surface">
      <table className="w-full border-separate border-spacing-0 text-left">
        <thead>
          <tr>
            {/* The header stays put while a long inventory scrolls under it, so
                a number three screens down is still a number in a named column.
                The page itself is what scrolls — there is no nested scroll
                container here, and the shell has no top chrome at this width
                for the header to hide behind. */}
            <th scope="col" className={`${HEAD} w-[24%]`}>
              {t('catalog.columnProduct')}
            </th>
            <th scope="col" className={`${HEAD} w-[22%]`}>
              {t('catalog.columnVariant')}
            </th>
            <th scope="col" className={`${HEAD} w-[15%]`}>
              {t('catalog.sku')}
            </th>
            <th scope="col" className={`${HEAD} w-[27%]`}>
              {t('stock.columnLocations')}
            </th>
            <th scope="col" className={`${HEAD} w-[12%] text-right`}>
              {t('stock.total')}
            </th>
          </tr>
        </thead>

        <tbody>
          {balances.map((variant) => (
            <tr key={variant.variantId} className="last:[&>*]:border-b-0 hover:bg-canvas">
              {/* The row's header, so every quantity in the row is announced
                  with the thing it is a quantity of. Moderate weight and
                  ordinary size: it is the identifier, not a headline. */}
              <th
                scope="row"
                className={`${CELL} wrap-anywhere text-[15px] font-semibold text-ink`}
              >
                {variant.productName}
              </th>

              <td
                className={`${CELL} wrap-anywhere text-[15px] ${
                  variant.attributes.length > 0 ? 'text-ink' : 'text-ink-soft'
                }`}
              >
                {variant.attributes.length > 0
                  ? formatVariantAttributes(variant.attributes)
                  : t('catalog.noAttributes')}
              </td>

              {/* Operational metadata, and secondary by weight — but selectable
                  and tabular, because somebody is matching it against a shelf
                  label character by character. The system stack, never a
                  downloaded font. */}
              <td
                className={`${CELL} tabular text-[13px] font-medium tracking-[0.02em] text-ink-soft`}
              >
                {variant.sku}
              </td>

              {/* Every shelf inside the one record, rather than a row per shelf:
                  the item is what somebody is looking for, and splitting it
                  across three unrelated-looking rows hides that they are one. */}
              <td className={CELL}>
                <LocationBreakdown locations={variant.locations} />
              </td>

              {/* The number the eye runs down the page for. Right-aligned and
                  tabular so the units line up under each other, heavier than
                  anything beside it, and no larger than it needs to be.
                  Straight from the projection — never re-added here. */}
              <td className={`${CELL} tabular text-right text-base font-semibold text-ink`}>
                {variant.totalQuantity}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
