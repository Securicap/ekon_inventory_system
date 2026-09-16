import type { Product, ProductVariant } from '@ekon/shared';
import { StatusChip, type ChipTone } from '../../components/StatusChip.js';
import { useTranslator, type Translator } from '../../i18n/index.js';
import { formatMoney } from '../../lib/money.js';
import { formatVariantAttributes } from '../../lib/variants.js';
import type { MessageKey } from '../../i18n/index.js';

/**
 * The merchandise master: what the shop sells, as merchandise rather than as
 * stock.
 *
 * This is the screen where Products stops looking like Inventory, and the
 * difference is carried by what each one puts first. Here it is identity —
 * brand, product name, how it is classified, what a variant costs and what it
 * sells for. There is **no quantity anywhere on this screen**, and that is the
 * point: a product exists whether or not there is any on the shelf, and the
 * answer to "how many" lives one destination away under a heading that says so.
 *
 * A card per product rather than one long table, because the unit somebody
 * reads is a product with its variants under it — a brand and a name at the
 * top, then the sizes and colours it comes in. A flat table would repeat the
 * brand and the classification on every row and still not group them.
 *
 * ```text
 * Steve Madden
 * Bel Ami                                   Active
 * Women · Footwear · Sandals
 *
 *   Black · Size 8 · Width M    EKN-ABC12345    HTG 7,500.00
 *   Black · Size 9 · Width M    EKN-DEF67890    HTG 7,500.00
 * ```
 */
export function ProductList({
  products,
  renderLifecycle,
}: {
  products: readonly Product[];
  /**
   * The lifecycle control for one product, for somebody who may change it.
   *
   * A render prop, so this stays a presentation: it decides where the control
   * sits and knows nothing about capabilities or about what a transition costs.
   */
  renderLifecycle?: ((product: Product) => React.ReactNode) | undefined;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {products.map((product) => (
        <li key={product.id}>
          <ProductCard product={product} renderLifecycle={renderLifecycle} />
        </li>
      ))}
    </ul>
  );
}

export const LIFECYCLE_LABEL_KEYS: Readonly<Record<Product['lifecycleStatus'], MessageKey>> = {
  ACTIVE: 'catalog.lifecycleActive',
  DISCONTINUED: 'catalog.lifecycleDiscontinued',
  ARCHIVED: 'catalog.lifecycleArchived',
};

/**
 * Active merchandise wears no chip at all.
 *
 * A label on every product would be a column of "Active" that nobody reads and
 * that makes the two states worth noticing harder to see. The exceptions are
 * the exceptions: amber for merchandise the shop no longer replenishes, grey
 * for merchandise it has retired.
 */
const LIFECYCLE_TONES: Readonly<Record<Product['lifecycleStatus'], ChipTone>> = {
  ACTIVE: 'positive',
  DISCONTINUED: 'attention',
  ARCHIVED: 'neutral',
};

function ProductCard({
  product,
  renderLifecycle,
}: {
  product: Product;
  renderLifecycle?: ((product: Product) => React.ReactNode) | undefined;
}) {
  const t = useTranslator();

  return (
    <article className="rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          {/* The brand above the name, smaller — the way it reads on a box.
              Absent for merchandise nobody has given one, and never guessed
              from the product name. */}
          {product.brand !== null && (
            <p className="text-sm font-medium text-ink-soft">{product.brand.name}</p>
          )}

          <h2 className="wrap-anywhere text-[17px] font-semibold text-ink">{product.name}</h2>

          {/* Audience · Category · Type, in the catalog's own order. A product
              nobody has classified says nothing rather than showing empty
              separators. */}
          {product.classifications.length > 0 && (
            <p className="mt-0.5 text-sm text-ink-soft">
              {product.classifications.map((entry) => entry.value).join(' · ')}
            </p>
          )}

          {product.description !== null && (
            <p className="mt-1 max-w-prose text-sm text-pretty text-ink-soft">
              {product.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {product.lifecycleStatus !== 'ACTIVE' && (
            <StatusChip
              label={t(LIFECYCLE_LABEL_KEYS[product.lifecycleStatus])}
              tone={LIFECYCLE_TONES[product.lifecycleStatus]}
            />
          )}
          {renderLifecycle !== undefined && renderLifecycle(product)}
        </div>
      </header>

      <ul className="flex flex-col divide-y divide-rule">
        {product.variants.map((variant) => (
          <li key={variant.id}>
            <VariantRow variant={variant} t={t} />
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * One sellable identity: how it differs from its siblings, what is printed on
 * its label, and what it is worth.
 *
 * Stacked on a phone and laid across on a laptop, from the same markup —
 * unlike the stock register, this is four short facts rather than a numeric
 * grid to be scanned down a column, so reflowing them is honest and a second
 * component would be two things to keep in step.
 *
 * **The SKU is never editable and never enterable.** It is generated by the
 * catalog and printed on the shelf label; the form that creates a product does
 * not offer a field for it, and this shows it as the identifier it is.
 */
function VariantRow({ variant, t }: { variant: ProductVariant; t: Translator }) {
  const attributes = formatVariantAttributes(variant.attributes);

  return (
    <div className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
      <p
        className={`min-w-0 flex-1 wrap-anywhere text-[15px] ${
          attributes === '' ? 'text-ink-soft' : 'text-ink'
        }`}
      >
        {attributes === '' ? t('catalog.noAttributes') : attributes}
        {variant.lifecycleStatus !== 'ACTIVE' && (
          <span className="ml-2 align-middle">
            <StatusChip
              label={t(LIFECYCLE_LABEL_KEYS[variant.lifecycleStatus])}
              tone={LIFECYCLE_TONES[variant.lifecycleStatus]}
            />
          </span>
        )}
      </p>

      <p className="tabular text-[13px] font-medium tracking-[0.02em] text-ink-soft sm:w-[26%]">
        <span className="sr-only">{t('catalog.sku')} </span>
        {variant.sku}
      </p>

      <div className="flex flex-col gap-0.5 sm:w-[28%] sm:items-end">
        {/* A price nobody has established is `null`, and `null` says so rather
            than showing a zero — free and unpriced are not the same fact. */}
        {variant.sellingPrice !== null ? (
          <p className="tabular text-[15px] font-semibold text-ink">
            <span className="sr-only">{t('catalog.price')} </span>
            {formatMoney(variant.sellingPrice)}
          </p>
        ) : (
          <p className="text-sm text-ink-muted">{t('catalog.noPrice')}</p>
        )}

        {/* Reference cost, quieter than the price and labelled, because it is
            not inventory valuation and must never be read as profit (INV-17). */}
        {variant.referenceCost !== null && (
          <p className="tabular text-sm text-ink-soft">
            {t('catalog.cost')} {formatMoney(variant.referenceCost)}
          </p>
        )}

        {variant.barcodes.length > 0 && (
          <p className="tabular text-xs text-ink-muted">
            <span className="sr-only">{t('catalog.barcodes')} </span>
            {variant.barcodes.join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}
