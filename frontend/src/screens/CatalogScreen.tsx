import { useState } from 'react';
import type { Product } from '@ekon/shared';
import { hasCapability } from '../auth/capabilities.js';
import { useAuthenticatedUser } from '../auth/useAuth.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PRIMARY_BUTTON } from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { catalogProductsQueryKey, getCatalogProducts } from '../lib/catalogQueries.js';
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
 */
export function CatalogScreen() {
  const t = useTranslator();
  const user = useAuthenticatedUser();

  const [creating, setCreating] = useState(false);
  /** The product the last submission created. Only ever set from a response. */
  const [created, setCreated] = useState<Product | null>(null);

  const products = useProtectedQuery({
    queryKey: catalogProductsQueryKey,
    queryFn: ({ signal }) => getCatalogProducts(signal),
  });

  const mayCreate = hasCapability(user, 'catalog.write');

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-medium">{t('catalog.title')}</h2>
        {mayCreate && !creating && (
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
        )}
      </div>

      {/* The confirmation outlives the form: it closes on success, and what is
          left on screen is the sentence naming the product and the list it now
          appears in. The SKUs are here because they are what goes on the shelf
          label, and the server is the only thing that could have chosen them. */}
      {created && (
        <div
          role="status"
          className="flex flex-col items-start gap-1 rounded-md border border-green-700 bg-green-50 px-4 py-3 text-green-900"
        >
          <p className="font-medium">{t('catalog.created', { name: created.name })}</p>
          <p className="tabular">
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
