import { useState } from 'react';
import type { Product } from '@ekon/shared';
import { useBreakpoint } from '../app/useBreakpoint.js';
import { hasCapability } from '../auth/capabilities.js';
import { useAuthenticatedUser } from '../auth/useAuth.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PageHeader } from '../components/PageHeader.js';
import { PRIMARY_BUTTON } from '../components/styles.js';
import { useTranslator, type Translator } from '../i18n/index.js';
import { catalogProductsQueryKey, getCatalogProducts } from '../lib/catalogQueries.js';
import { ProductRecords } from './catalog/ProductRecords.js';
import { ProductTable } from './catalog/ProductTable.js';
import { NewProductForm } from './NewProductForm.js';

/**
 * The catalog: what the shop sells, and — for somebody who may write it — the
 * form that puts the first item in it.
 *
 * `GET /api/catalog/products` requires `catalog.read`, and the nav entry that
 * leads here is shown for the same capability — but the two are not the same
 * claim. The nav entry is a convenience; this request is checked by the server,
 * which is why a `403` is a state this screen renders rather than a case that
 * cannot happen. Somebody's role can change between the page loading and the
 * request being made.
 *
 * Creation lives here rather than on a screen of its own because the list is
 * the confirmation: a product created is a product visible, one line below the
 * form that made it. It is offered on `catalog.write` — a different permission
 * from the one that opens this screen, and somebody may hold either without the
 * other. The server checks it again on the request, which is the boundary that
 * matters; hiding a form nobody may submit is a usability property and that is
 * all.
 *
 * What is listed is Product → Variant → SKU and nothing else. There is no
 * price, no cost, no supplier, no category, no stock figure: each of those is a
 * separate decision about what the catalog *is*, and this screen must not imply
 * the answer by leaving a column where one would go.
 */
export function CatalogScreen() {
  const t = useTranslator();
  const user = useAuthenticatedUser();
  const breakpoint = useBreakpoint();

  const [creating, setCreating] = useState(false);
  /** The product the last submission created. Only ever set from a response. */
  const [created, setCreated] = useState<Product | null>(null);

  const products = useProtectedQuery({
    queryKey: catalogProductsQueryKey,
    queryFn: ({ signal }) => getCatalogProducts(signal),
  });

  const mayCreate = hasCapability(user, 'catalog.write');

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title={t('catalog.title')}
        subtitle={subtitle(t, products.data)}
        aside={
          mayCreate &&
          !creating && (
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() => {
                setCreated(null);
                setCreating(true);
              }}
            >
              {t('catalog.newProduct')}
            </button>
          )
        }
      />

      {/* The confirmation outlives the form: it closes on success, and what is
          left on screen is the sentence naming the product and the list it now
          appears in. The SKUs are here because they are what goes on the shelf
          label, and the server is the only thing that could have chosen them. */}
      {created && (
        <div
          role="status"
          className="flex flex-col gap-1 rounded-md border border-success bg-success-soft px-4 py-3.5"
        >
          <p className="text-xs font-bold tracking-[0.08em] text-success uppercase">
            {t('catalog.createdLabel')}
          </p>
          <p className="text-base font-semibold text-success-ink">
            {t('catalog.created', { name: created.name })}
          </p>
          <p className="tabular text-[15px] text-success-ink">
            {t('catalog.createdHint', {
              skus: created.variants.map((variant) => variant.sku).join(', '),
            })}
          </p>
        </div>
      )}

      {creating && (
        <NewProductForm
          onCreated={(product) => {
            setCreated(product);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {products.isPending && (
        <p role="status" className="text-[15px] text-ink-soft">
          {t('status.loading')}
        </p>
      )}

      {/* A 403 lands here as "you may not do this" and nothing more. It does not
          sign anybody out: they are signed in, and signing in again would change
          nothing. */}
      {products.isError && <ErrorNotice error={products.error} />}

      {products.data?.length === 0 && (
        <div className="rounded-lg border border-line bg-surface px-4 py-6">
          <p className="text-[15px] text-ink-soft">{t('catalog.empty')}</p>
          {/* Only somebody who may create one is pointed at the way to do it.
              An employee reading an empty catalog is told what is true and not
              sent to a button that is not on their screen. */}
          {mayCreate && <p className="mt-1 text-[15px] text-ink-soft">{t('catalog.emptyHint')}</p>}
        </div>
      )}

      {products.data !== undefined &&
        products.data.length > 0 &&
        (breakpoint === 'mobile' ? (
          <ProductRecords products={products.data} />
        ) : (
          <ProductTable products={products.data} />
        ))}
    </section>
  );
}

/**
 * What the catalog holds, counted from what actually arrived, plus the one fact
 * about SKUs somebody needs before they go looking for a field to type one in.
 *
 * Singular and plural are separate messages rather than one string with an `s`
 * bolted on: a shop with one product reads this on its first day, and "1
 * produits" is the kind of small wrongness that makes software feel untrusted.
 */
function subtitle(t: Translator, products: readonly Product[] | undefined): string | undefined {
  if (products === undefined) return undefined;

  const variants = products.reduce((total, product) => total + product.variants.length, 0);

  return [
    t(products.length === 1 ? 'catalog.countProductsOne' : 'catalog.countProducts', {
      count: products.length,
    }),
    t(variants === 1 ? 'catalog.countVariantsOne' : 'catalog.countVariants', { count: variants }),
    t('catalog.skuFromServer'),
  ].join(' · ');
}
