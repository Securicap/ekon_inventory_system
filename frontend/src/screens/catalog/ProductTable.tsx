import type { Product, ProductVariant } from '@ekon/shared';
import { useTranslator } from '../../i18n/index.js';
import { formatVariantAttributes } from '../../lib/variants.js';

/**
 * The catalog as a register: one row per variant, grouped under the product it
 * belongs to.
 *
 * A real `<table>`, because this really is one — three columns of the same
 * facts repeated down the page. The product name is a `<th scope="rowgroup">`
 * spanning its variants, which is both what the design draws and what tells a
 * screen reader that these two SKUs belong to one product rather than being
 * three unrelated rows that happen to sit together.
 *
 * Each product is its own `<tbody>`. That is the element the grouping is made
 * of; without it the row span would be a visual trick over one long list.
 */
export function ProductTable({ products }: { products: readonly Product[] }) {
  const t = useTranslator();

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className={`${HEAD} w-[36%]`}>
              {t('catalog.columnProduct')}
            </th>
            <th scope="col" className={`${HEAD} w-[40%]`}>
              {t('catalog.columnVariant')}
            </th>
            <th scope="col" className={HEAD}>
              {t('catalog.sku')}
            </th>
          </tr>
        </thead>

        {products.map((product) => (
          <ProductRows key={product.id} product={product} />
        ))}
      </table>
    </div>
  );
}

const HEAD = 'px-3 py-3 text-xs font-bold tracking-[0.06em] text-ink-muted uppercase align-bottom';

const CELL = 'px-3 py-3.5 align-baseline';

function ProductRows({ product }: { product: Product }) {
  const t = useTranslator();

  /**
   * A product always has at least one variant — creating one without any is not
   * something the contract allows. The fallback row exists so that if the
   * server ever answered with none, the product would still be listed rather
   * than silently vanish from the register.
   */
  const rows: readonly (ProductVariant | undefined)[] =
    product.variants.length > 0 ? product.variants : [undefined];

  return (
    <tbody className="border-b border-line last:border-b-0">
      {rows.map((variant, index) => (
        <tr key={variant?.id ?? product.id} className="border-b border-rule last:border-b-0">
          {index === 0 && (
            <th scope="rowgroup" rowSpan={rows.length} className={`${CELL} font-semibold text-ink`}>
              {product.name}
            </th>
          )}

          <td
            className={`${CELL} text-[15px] ${variant?.attributes.length ? 'text-ink' : 'text-ink-soft'}`}
          >
            {variant === undefined
              ? '—'
              : variant.attributes.length > 0
                ? formatVariantAttributes(variant.attributes)
                : t('catalog.noAttributes')}
          </td>

          <td className={`${CELL} tabular text-[13px] font-medium tracking-[0.02em] text-ink-soft`}>
            {variant?.sku ?? '—'}
          </td>
        </tr>
      ))}
    </tbody>
  );
}
