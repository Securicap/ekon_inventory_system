import { Fragment, useMemo, useState } from 'react';
import type { VariantStockBalance } from '@ekon/shared';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { SECONDARY_BUTTON, TEXT_INPUT } from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { getInventoryBalances, inventoryBalancesQueryKey } from '../lib/inventoryQueries.js';
import { filterStockBalances } from '../lib/stock.js';
import { formatVariantAttributes } from '../lib/variants.js';

/**
 * What the business has, and where it is.
 *
 * This screen answers one question and refuses to answer any other. It is not a
 * dashboard, not a report, and not a history: there is no chart, no total
 * across items, no valuation, no low-stock colour, and nothing about how the
 * numbers got where they are. An employee at the counter needs to know whether
 * there is rice, how much, and on which shelf — and every extra number on this
 * page is one more thing to read past to find that out.
 *
 * It reads `GET /api/inventory/balances` and nothing else. That response
 * already carries the product name, the SKU, the attributes, and every active
 * location's name, so this screen does not read the catalog and does not read
 * the location list — the two queries a screen assembling the same picture out
 * of pieces would need, and two more chances for the pieces to disagree.
 *
 * **Nothing here changes anything.** There is no adjust button, no removal, no
 * count, and the rows are not clickable, because there is nothing yet for a
 * click to do. Receiving is where stock arrives, and the rest are their own
 * workflows.
 *
 * The visual design is still temporary, like every other screen here.
 */
export function InventoryScreen() {
  const t = useTranslator();
  const [search, setSearch] = useState('');

  const balances = useProtectedQuery({
    queryKey: inventoryBalancesQueryKey,
    queryFn: ({ signal }) => getInventoryBalances(signal),
  });

  const stock = balances.data;
  const matches = useMemo(() => filterStockBalances(stock ?? [], search), [stock, search]);

  /** Whether there is anything to search *through*, as opposed to nothing to show. */
  const searchable = stock !== undefined && stock.length > 0;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-medium">{t('stock.title')}</h2>
        <p className="text-slate-600">{t('stock.description')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <label htmlFor="stock-search" className="font-medium">
            {t('stock.searchLabel')}
          </label>
          {/* A visible label, not a placeholder standing in for one: the
              placeholder disappears the moment somebody types, and a field
              whose name vanishes on first use has no name. */}
          <input
            id="stock-search"
            type="search"
            name="stockSearch"
            className={TEXT_INPUT}
            value={search}
            placeholder={t('stock.searchPlaceholder')}
            disabled={!searchable}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {/* Refreshing is explicit and manual. There is no polling and no
            interval: a shop on an unreliable connection should spend its
            bandwidth when somebody asks a question, not on a timer nobody set.
            Disabled while a fetch is in flight, so pressing it twice cannot
            start a second one. */}
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={balances.isFetching}
          onClick={() => void balances.refetch()}
        >
          {balances.isFetching ? t('stock.refreshing') : t('stock.refresh')}
        </button>
      </div>

      {/* `isPending` and not `isFetching`: a refresh keeps the numbers on screen
          rather than replacing them with a loading line somebody has to wait
          out. Only the first read has nothing to show. */}
      {balances.isPending && <p className="text-slate-600">{t('status.loading')}</p>}

      {/* A 403 lands here as "you may not do this" and nothing more; a dropped
          connection lands here after the retries the query client already made.
          Neither signs anybody out, and the refresh button above is how either
          one is recovered from. */}
      {balances.isError && <ErrorNotice error={balances.error} />}

      {/* The database has no active variant to stock. Distinct from a search
          that matched none, below — one is an empty shop, the other is a typo,
          and telling somebody the wrong one sends them to fix the wrong thing. */}
      {stock?.length === 0 && <p className="text-slate-700">{t('stock.noVariants')}</p>}

      {searchable && matches.length === 0 && (
        <p role="status" className="text-slate-700">
          {t('stock.noMatches')}
        </p>
      )}

      {matches.length > 0 && (
        <ul className="flex flex-col gap-3">
          {matches.map((variant) => (
            <VariantStockCard key={variant.variantId} variant={variant} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One item: what it is, how much there is altogether, and how that is split
 * across the shelves.
 *
 * A card rather than a row in a wide table. This is read on a phone as often as
 * on the shop laptop, and a spreadsheet that needs sideways scrolling to reach
 * the quantity is a spreadsheet nobody reads at a counter.
 *
 * Deliberately absent: the variant id, the product id, and the location ids —
 * they identify rows to a database and mean nothing to the person holding the
 * box. So is `updatedAt`, which says when a projection last moved, not when
 * anybody last counted; showing it as a business fact would invite somebody to
 * trust it as one.
 */
function VariantStockCard({ variant }: { variant: VariantStockBalance }) {
  const t = useTranslator();
  const attributes = formatVariantAttributes(variant.attributes);

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="font-medium">{variant.productName}</h3>

      {attributes !== '' && <p className="text-sm text-slate-700">{attributes}</p>}

      <p className="tabular text-sm text-slate-600">
        <span className="sr-only">{t('catalog.sku')}</span> {variant.sku}
      </p>

      <p className="mt-3">
        {t('stock.total')}
        {': '}
        <span className="tabular text-lg font-semibold">{variant.totalQuantity}</span>
      </p>

      {variant.locations.length === 0 ? (
        /* The business has no active location at all. An operational problem to
           say out loud, not a row to hide and not a shelf to invent. */
        <p className="mt-2 text-slate-700">{t('stock.noLocations')}</p>
      ) : (
        /* Every active location, including the ones holding nothing. A zero is
           an answer — "we have none in the Main Store" — and a location dropped
           for being empty would read as a location that does not exist.

           A description list, so each number is read with the shelf it belongs
           to rather than as a figure floating beside a name. */
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-slate-100 pt-2">
          {variant.locations.map((location) => (
            <Fragment key={location.locationId}>
              <dt className="flex flex-wrap items-center gap-2 text-slate-700">
                {location.locationName}
                {/* A word, not a colour or a dot: somebody who cannot see the
                    difference reads the same marker everybody else does. */}
                {location.isDefault && (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                    {t('inventory.defaultLocation')}
                  </span>
                )}
              </dt>
              <dd className="tabular text-right font-medium text-slate-900">{location.quantity}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </li>
  );
}
