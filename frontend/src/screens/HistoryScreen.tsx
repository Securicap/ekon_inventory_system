import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { InventoryMovementRecord } from '@ekon/shared';
import type { ViewFocus } from '../app/navigation.js';
import { hasCapability } from '../auth/capabilities.js';
import { useAuthenticatedUser } from '../auth/useAuth.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PageHeader } from '../components/PageHeader.js';
import { SECONDARY_BUTTON } from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { getInventoryBalances, inventoryBalancesQueryKey } from '../lib/inventoryQueries.js';
import { getMovements, movementsQueryKey, type MovementFilters } from '../lib/movementsApi.js';
import { HistoryFilters } from './history/HistoryFilters.js';
import { MovementList } from './history/MovementList.js';
import { ReverseDialog } from './history/ReverseDialog.js';

/**
 * Stock history: what changed the numbers, newest first.
 *
 * This is the evidence screen. Every other screen answers what is true now —
 * this one answers how it got that way, which is the question somebody asks
 * when the two disagree. It reads the append-only ledger and writes exactly one
 * kind of thing to it: a reversal, from a row, for somebody who may.
 *
 * **Labels are current, not historical.** The ledger stores ids; the product
 * name, the location name and the person's name are resolved by the server from
 * the tables that own them today. A product renamed last week changes what an
 * old movement *displays* while the movement still refers to the same variant
 * and SKU. Nothing here pretends otherwise, and the README says so too.
 *
 * Pagination is the cursor the API gives, and a "load more" that appends. Not
 * page numbers: the ledger grows at the front, so page four means something
 * different every time a receipt is booked in.
 */
export function HistoryScreen({ focus }: { focus: ViewFocus | null }) {
  const t = useTranslator();
  const user = useAuthenticatedUser();
  const queryClient = useQueryClient();

  /**
   * The filters, seeded from wherever this screen was opened.
   *
   * Arriving from an inventory row means "this item's history", so the row's
   * variant is the starting filter rather than an unfiltered feed somebody has
   * to search. Arriving from the sidebar means the whole ledger.
   */
  const [filters, setFilters] = useState<MovementFilters>(() => ({
    variantId: focus?.variantId,
    locationId: focus?.locationId,
  }));

  /**
   * The pages loaded so far, and the cursor for the next one.
   *
   * Kept here rather than in the query key: successive pages of one filter are
   * one answer, and keying by cursor would make each page its own cache entry
   * that the first one could never invalidate. Changing a filter resets both —
   * concatenating rows from two different questions would be a feed that is
   * true of neither.
   */
  const [pages, setPages] = useState<InventoryMovementRecord[]>([]);
  /**
   * `undefined` while nothing further has been loaded — the first page's own
   * cursor is the one to use then. Once a further page has come back, this is
   * *its* cursor, and `null` means the feed has been read to the end.
   *
   * The distinction is load-bearing: collapsing the two into `null` would make
   * the end of the feed indistinguishable from the start of it, and the screen
   * would keep offering a "load more" that fetched page two again forever.
   */
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [reversing, setReversing] = useState<InventoryMovementRecord | null>(null);

  const first = useProtectedQuery({
    queryKey: movementsQueryKey(filters),
    queryFn: ({ signal }) => getMovements(filters, null, signal),
  });

  /**
   * The variants and locations somebody can filter by, taken from the stock
   * read they already have.
   *
   * The API filters by uuid, and a person cannot be asked to type one — so the
   * choices are names, and the uuid never appears on screen. `balances` is the
   * right source because it is the operational list: filtering history by
   * merchandise the shop archived years ago is not what somebody standing at a
   * shelf is trying to do, and the unfiltered feed still shows every movement
   * of it.
   */
  const balances = useProtectedQuery({
    queryKey: inventoryBalancesQueryKey,
    queryFn: ({ signal }) => getInventoryBalances(signal),
  });

  /** The first page from the query, then anything "load more" appended. */
  const movements = useMemo(
    () => [...(first.data?.items ?? []), ...pages],
    [first.data?.items, pages],
  );

  const nextCursor = cursor === undefined ? (first.data?.nextCursor ?? null) : cursor;
  const mayReverse = hasCapability(user, 'inventory.reverse');

  function changeFilters(next: MovementFilters): void {
    setFilters(next);
    setPages([]);
    setCursor(undefined);
  }

  const [loadingMore, setLoadingMore] = useState(false);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getMovements(filters, nextCursor, new AbortController().signal);
      setPages((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      // The button stays, and pressing it again is the retry. A failed page is
      // not worth an error banner over a feed that is already readable.
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * After a reversal: the ledger has a new movement and the shelf has a new
   * quantity, and this screen shows the first.
   *
   * Both feeds are invalidated by prefix rather than by exact key, because the
   * reversal is visible under whichever filters anybody has open — and the
   * balances, because a reversal moved stock. Counts are untouched: reversing a
   * reconciliation's movement does not un-count anything, and the count record
   * keeps saying what it always said.
   */
  function afterReversal(): void {
    setPages([]);
    setCursor(undefined);
    void queryClient.invalidateQueries({ queryKey: ['inventory', 'movements'] }).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: inventoryBalancesQueryKey }).catch(() => {});
    setReversing(null);
  }

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title={t('history.title')}
        subtitle={t('history.description')}
        aside={
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={first.isFetching}
            onClick={() => {
              setPages([]);
              setCursor(undefined);
              void first.refetch();
            }}
          >
            {first.isFetching ? t('stock.refreshing') : t('stock.refresh')}
          </button>
        }
      />

      <HistoryFilters filters={filters} balances={balances.data ?? []} onChange={changeFilters} />

      {first.isPending && (
        <p role="status" className="text-[15px] text-ink-soft">
          {t('status.loading')}
        </p>
      )}

      {first.isError && <ErrorNotice error={first.error} onRetry={() => void first.refetch()} />}

      {first.data && movements.length === 0 && (
        <div className="rounded-lg border border-line bg-surface px-4 py-6">
          <p className="text-[15px] text-ink-soft">{t('history.empty')}</p>
        </div>
      )}

      {movements.length > 0 && (
        <MovementList movements={movements} onReverse={mayReverse ? setReversing : undefined} />
      )}

      {nextCursor !== null && movements.length > 0 && (
        <div>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? t('status.loading') : t('history.loadMore')}
          </button>
        </div>
      )}

      {reversing !== null && (
        <ReverseDialog
          movement={reversing}
          onDone={afterReversal}
          onCancel={() => setReversing(null)}
        />
      )}
    </section>
  );
}
