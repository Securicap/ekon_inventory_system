import { useMemo, useState } from 'react';
import { useBreakpoint } from '../app/useBreakpoint.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PageHeader } from '../components/PageHeader.js';
import { SECONDARY_BUTTON, TEXT_INPUT } from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { getInventoryBalances, inventoryBalancesQueryKey } from '../lib/inventoryQueries.js';
import { filterStockBalances } from '../lib/stock.js';
import { InventoryRecords } from './inventory/InventoryRecords.js';
import { InventoryTable } from './inventory/InventoryTable.js';
import { InventoryTabletTable } from './inventory/InventoryTabletTable.js';

/**
 * What the business has, which variant it is, where it is, and how much there
 * is.
 *
 * This screen answers those four questions and refuses to answer any other. It
 * is not a dashboard, not a report, and not a history: there is no chart, no
 * valuation, no low-stock colour, no reorder point, and nothing about how the
 * numbers got where they are. An employee at the counter needs to know whether
 * there is rice, how much, and on which shelf — and every extra number on this
 * page is one more thing to read past to find that out.
 *
 * It reads `GET /api/inventory/balances` and nothing else, under the canonical
 * key that receiving and removal invalidate after a confirmed movement. That
 * response already carries the product name, the SKU, the attributes, and every
 * active location's name, so this screen does not read the catalog and does not
 * read the location list — the two queries a screen assembling the same picture
 * out of pieces would need, and two more chances for the pieces to disagree.
 *
 * **Nothing here changes anything.** There is no adjust button, no removal, no
 * count, and the rows are not clickable. Receiving and removal are separate
 * destinations behind separate capabilities: somebody may hold `inventory.read`
 * and neither of the others, so this screen offers no way into either of them.
 *
 * Three presentations, one at a time: a five-column table on a laptop, a
 * three-column one on a tablet, and a stack of records on a phone. They are
 * different markup rather than one markup with columns hidden, because a
 * hidden column is still in the document — two announcements for a screen
 * reader and two matches for a test. What they are never allowed to differ
 * about is *which* items they show: the filtering happens once, here, and all
 * three are handed the same list.
 */
export function InventoryScreen() {
  const t = useTranslator();
  const breakpoint = useBreakpoint();
  const [search, setSearch] = useState('');

  const balances = useProtectedQuery({
    queryKey: inventoryBalancesQueryKey,
    queryFn: ({ signal }) => getInventoryBalances(signal),
  });

  const stock = balances.data;

  /* Computed once, for whichever presentation is mounted. Three components
     filtering the same query three ways is three chances for a phone and a
     laptop to disagree about what the shop has. */
  const matches = useMemo(() => filterStockBalances(stock ?? [], search), [stock, search]);

  /** Whether there is anything to search *through*, as opposed to nothing to show. */
  const searchable = stock !== undefined && stock.length > 0;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title={t('stock.title')}
        subtitle={t('stock.description')}
        aside={
          /* Refreshing is explicit and manual. There is no polling and no
             interval: a shop on an unreliable connection should spend its
             bandwidth when somebody asks a question, not on a timer nobody set.
             It is the query's own refetch, not a second request — and it is
             secondary, because asking again changes nothing in the shop.
             Disabled while a fetch is in flight, so pressing it twice cannot
             start two. */
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={balances.isFetching}
            onClick={() => void balances.refetch()}
          >
            {balances.isFetching ? t('stock.refreshing') : t('stock.refresh')}
          </button>
        }
      />

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="flex min-w-56 max-w-md flex-1 flex-col gap-1">
          <label htmlFor="stock-search" className="text-[15px] font-semibold text-ink">
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

        {/* How many records are on screen, and nothing more. Not a business
            figure — it counts what the field above left visible, which is why
            it only appears once there is a list for it to be counting.

            `aria-live` rather than `role="status"`: this is a number that
            changes under somebody's typing and is worth hearing, but the screen
            already has one status region for the sentence that says a search
            matched nothing, and two would talk over each other. */}
        {searchable && (
          <p aria-live="polite" className="tabular pb-3 text-[15px] text-ink-soft">
            {t(matches.length === 1 ? 'stock.resultsOne' : 'stock.results', {
              count: matches.length,
            })}
          </p>
        )}
      </div>

      {/* `isPending` and not `isFetching`: a refresh keeps the numbers on screen
          rather than replacing them with a loading line somebody has to wait
          out. Only the first read has nothing to show. */}
      {balances.isPending && (
        <p role="status" className="text-[15px] text-ink-soft">
          {t('status.loading')}
        </p>
      )}

      {/* A 403 lands here as "you may not do this" and nothing more; a dropped
          connection lands here after the retries the query client already made.
          Neither signs anybody out, and the refresh button above is how either
          one is recovered from. */}
      {balances.isError && <ErrorNotice error={balances.error} />}

      {/* The database has no active variant to stock. Distinct from a search
          that matched none, below — one is an empty shop, the other is a typo,
          and telling somebody the wrong one sends them to fix the wrong thing.

          No "receive some stock" invitation under it: reading stock and booking
          it in are different capabilities, and pointing somebody at a screen
          their account cannot open is worse than saying only what is true. */}
      {stock?.length === 0 && (
        <div className="rounded-lg border border-line bg-surface px-4 py-6">
          <p className="text-[15px] text-ink-soft">{t('stock.noVariants')}</p>
        </div>
      )}

      {searchable && matches.length === 0 && (
        <div role="status" className="rounded-lg border border-line bg-surface px-4 py-6">
          <p className="text-[15px] text-ink-soft">{t('stock.noMatches')}</p>
        </div>
      )}

      {matches.length > 0 &&
        (breakpoint === 'mobile' ? (
          <InventoryRecords balances={matches} />
        ) : breakpoint === 'tablet' ? (
          <InventoryTabletTable balances={matches} />
        ) : (
          <InventoryTable balances={matches} />
        ))}
    </section>
  );
}
