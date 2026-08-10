import type { Product } from '@ekon/shared';
import { useTranslator } from '../../i18n/index.js';
import { formatVariantAttributes } from '../../lib/variants.js';

/**
 * The catalog on a phone: one compact record per product, its variants nested
 * under the name.
 *
 * Not the table at a smaller size. Three columns in 390px would either scroll
 * sideways or squeeze the SKU — the one string somebody is holding a box to
 * match — into two lines. The hierarchy is carried by nesting instead of by
 * columns: a heading for the product, a list under it for its variants, and
 * inside each variant the attributes above the SKU.
 *
 * It stays a list rather than becoming cards. There is no border around every
 * fact; one rule between variants and one between products is enough to read.
 */
export function ProductRecords({ products }: { products: readonly Product[] }) {
  const t = useTranslator();

  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {products.map((product) => (
        <li key={product.id} className="px-4 py-3">
          <h2 className="text-[17px] font-semibold text-ink">{product.name}</h2>

          <ul className="mt-1 flex flex-col divide-y divide-rule">
            {product.variants.map((variant) => (
              <li key={variant.id} className="flex flex-col gap-0.5 py-2 last:pb-0">
                <span
                  className={`text-[15px] ${
                    variant.attributes.length > 0 ? 'text-ink' : 'text-ink-soft'
                  }`}
                >
                  {variant.attributes.length > 0
                    ? formatVariantAttributes(variant.attributes)
                    : t('catalog.noAttributes')}
                </span>

                <span className="tabular text-[13px] font-medium tracking-[0.02em] text-ink-soft">
                  <span className="sr-only">{t('catalog.sku')} </span>
                  {variant.sku}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
