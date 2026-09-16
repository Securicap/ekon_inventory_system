import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CountRecord } from '@ekon/shared';
import type { ViewFocus } from '../app/navigation.js';
import { hasCapability } from '../auth/capabilities.js';
import { useAuthenticatedUser } from '../auth/useAuth.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PageHeader } from '../components/PageHeader.js';
import { PANEL } from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { countsQueryKey, countsQueryPrefix, getCounts } from '../lib/countsApi.js';
import { getInventoryBalances, inventoryBalancesQueryKey } from '../lib/inventoryQueries.js';
import { movementsQueryPrefix } from '../lib/movementsApi.js';
import { CountList } from './counts/CountList.js';
import { RecordCountForm } from './counts/RecordCountForm.js';
import { ReconcileDialog } from './counts/ReconcileDialog.js';

/**
 * Physical counts: what somebody saw on the shelf, and what the shop decided
 * about the difference.
 *
 * > **A count observes. Investigation explains. Reconciliation changes stock.**
 *
 * The screen is built around that sentence and it is worth saying how, because
 * the tempting design breaks it. Recording a count here changes **nothing** —
 * not the balance, not the ledger, not this screen's own stock figures — and
 * the form says so out loud before anybody types a number. The variance that
 * comes back is evidence, it sits in the list below marked as needing review,
 * and it stays there until a person with `inventory.count` accepts it and says
 * why.
 *
 * Two responsibilities, one page: record a count, and review the ones that did
 * not match. They are together because they are the same job an hour apart —
 * somebody walks the shelves, then sits down and works through what did not
 * add up. Splitting them across two destinations would hide the second half
 * behind a door nobody opens.
 *
 * **This is not a stocktake platform.** There is no session, no scope, no
 * campaign, no blind count, and no approval queue. One observation covers one
 * item at one location.
 */
export function CountsScreen({ focus }: { focus: ViewFocus | null }) {
  const t = useTranslator();
  const user = useAuthenticatedUser();
  const queryClient = useQueryClient();

  const mayCount = hasCapability(user, 'inventory.count');

  /**
   * Which counts the list is showing. Unresolved discrepancies first, because
   * that is the question the screen exists to answer — and every count second,
   * for somebody checking whether a shelf was walked at all.
   */
  const [showing, setShowing] = useState<'OPEN' | 'ALL'>('OPEN');
  const [reconciling, setReconciling] = useState<CountRecord | null>(null);
  /** The observation this screen just recorded, kept so its result stays on screen. */
  const [recorded, setRecorded] = useState<CountRecord | null>(null);

  const filters = showing === 'OPEN' ? { status: 'OPEN' as const } : {};

  const counts = useProtectedQuery({
    queryKey: countsQueryKey(filters),
    queryFn: ({ signal }) => getCounts(filters, null, signal),
  });

  /** The merchandise and shelves a count can be recorded against. */
  const balances = useProtectedQuery({
    queryKey: inventoryBalancesQueryKey,
    queryFn: ({ signal }) => getInventoryBalances(signal),
  });

  /**
   * A recorded observation changes the count feed and **nothing else**.
   *
   * This is the invalidation rule the whole workflow rests on: no balances, no
   * movement history, because recording a count posts no movement and moves no
   * stock. Invalidating them would be this screen quietly implying that
   * something changed on the shelf.
   */
  function afterRecord(count: CountRecord): void {
    setRecorded(count);
    void queryClient.invalidateQueries({ queryKey: countsQueryPrefix }).catch(() => {});
  }

  /**
   * A reconciliation is the opposite: it posted a movement, so the shelf and
   * the ledger both changed, and all three feeds are now out of date.
   */
  function afterReconcile(): void {
    setReconciling(null);
    void queryClient.invalidateQueries({ queryKey: countsQueryPrefix }).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: inventoryBalancesQueryKey }).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: movementsQueryPrefix }).catch(() => {});
  }

  return (
    <section className="flex flex-col gap-5">
      <PageHeader title={t('counts.title')} subtitle={t('counts.description')} />

      {mayCount && (
        <RecordCountForm
          balances={balances.data ?? []}
          focus={focus}
          recorded={recorded}
          onRecorded={afterRecord}
          onDismiss={() => setRecorded(null)}
        />
      )}

      <section className={`${PANEL} flex flex-col gap-4`} aria-labelledby="counts-review">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="counts-review" className="text-lg font-semibold text-ink">
              {t('counts.reviewTitle')}
            </h2>
            <p className="text-sm text-ink-soft">{t('counts.reviewDescription')}</p>
          </div>

          {/* Two answers to one question, as radio buttons rather than a select:
              there are exactly two and both fit, and a person can see which one
              they are looking at without opening anything. */}
          <fieldset className="flex gap-1 rounded-md border border-line p-1">
            <legend className="sr-only">{t('counts.filterLegend')}</legend>
            {(['OPEN', 'ALL'] as const).map((option) => (
              <label
                key={option}
                className={`cursor-pointer rounded px-3 py-1.5 text-sm font-medium ${
                  showing === option ? 'bg-accent-soft text-accent-ink' : 'text-ink-soft'
                }`}
              >
                <input
                  type="radio"
                  name="counts-filter"
                  className="sr-only"
                  checked={showing === option}
                  onChange={() => setShowing(option)}
                />
                {t(option === 'OPEN' ? 'counts.filterOpen' : 'counts.filterAll')}
              </label>
            ))}
          </fieldset>
        </div>

        {counts.isPending && (
          <p role="status" className="text-[15px] text-ink-soft">
            {t('status.loading')}
          </p>
        )}

        {counts.isError && (
          <ErrorNotice error={counts.error} onRetry={() => void counts.refetch()} />
        )}

        {counts.data?.items.length === 0 && (
          <p className="text-[15px] text-ink-soft">
            {t(showing === 'OPEN' ? 'counts.noneOpen' : 'counts.none')}
          </p>
        )}

        {counts.data !== undefined && counts.data.items.length > 0 && (
          <CountList
            counts={counts.data.items}
            onReconcile={mayCount ? setReconciling : undefined}
          />
        )}
      </section>

      {reconciling !== null && (
        <ReconcileDialog
          count={reconciling}
          onDone={afterReconcile}
          onCancel={() => setReconciling(null)}
        />
      )}
    </section>
  );
}
