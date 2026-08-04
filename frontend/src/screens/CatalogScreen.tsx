import type { ListProductsResponse } from '@ekon/shared';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useTranslator } from '../i18n/index.js';
import { api } from '../lib/api.js';

/**
 * The catalog, read-only.
 *
 * `GET /api/catalog/products` requires `catalog.read`, and the nav entry that
 * leads here is shown for the same capability — but the two are not the same
 * claim. The nav entry is a convenience; this request is checked by the server,
 * which is why a `403` is a state this screen renders rather than a case that
 * cannot happen. Somebody's role can change between the page loading and the
 * request being made.
 *
 * Creating a product needs `catalog.write` and a form, and neither is this PR.
 */
export function CatalogScreen() {
  const t = useTranslator();

  const products = useProtectedQuery({
    queryKey: ['catalog', 'products'],
    queryFn: ({ signal }) => api.get<ListProductsResponse>('/api/catalog/products', signal),
  });

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-medium">{t('catalog.title')}</h2>

      {products.isPending && <p className="text-slate-600">{t('status.loading')}</p>}

      {/* A 403 lands here as "you may not do this" and nothing more. It does not
          sign anybody out: they are signed in, and signing in again would change
          nothing. */}
      {products.isError && <ErrorNotice error={products.error} />}

      {products.data?.length === 0 && <p className="text-slate-600">{t('catalog.empty')}</p>}

      {products.data && products.data.length > 0 && (
        <ul className="flex flex-col gap-3">
          {products.data.map((product) => (
            <li key={product.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="font-medium">{product.name}</h3>
              <p className="text-sm text-slate-600">
                {t('catalog.variants')}
                {': '}
                <span className="tabular">{product.variants.length}</span>
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {product.variants.map((variant) => (
                  <li
                    key={variant.id}
                    className="tabular rounded border border-slate-200 px-2 py-1 text-sm text-slate-700"
                  >
                    <span className="sr-only">{t('catalog.sku')}</span> {variant.sku}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
