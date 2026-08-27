import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { LifecycleStatus, Product } from '@ekon/shared';
import { useAuth } from '../../auth/useAuth.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { useTranslator } from '../../i18n/index.js';
import { ApiError } from '../../lib/api.js';
import { catalogProductsQueryKey } from '../../lib/catalogQueries.js';
import { inventoryBalancesQueryKey } from '../../lib/inventoryQueries.js';
import { setProductLifecycle } from '../../lib/lifecycleApi.js';
import type { MessageKey } from '../../i18n/index.js';

/**
 * Withdrawing merchandise, and bringing it back.
 *
 * Three states, in plain words rather than as a state machine:
 *
 *   **Active**        sold and restocked normally.
 *   **Discontinued**  no longer restocked. What is on the shelf is still sold
 *                     and still counted.
 *   **Archived**      out of day-to-day use, kept for history.
 *
 * The consequence is spelled out before the change, because both of the
 * interesting ones are easy to misread. "Discontinued" sounds like *gone* and
 * is not — the units on the shelf are still the shop's and still sell.
 * "Archived" sounds like *deleted* and is not — the history stays, and the
 * server refuses it outright while any stock remains.
 *
 * **Nothing here moves stock, in either direction.** If archiving is refused
 * because six are still on a shelf, this offers no button to write them off:
 * that would be a lifecycle screen posting an inventory movement, which is the
 * one thing a lifecycle change must never do. The refusal is shown as what it
 * is, and the remedy is to sell or correct the remaining stock somewhere that
 * says so.
 */
export function LifecycleControl({ product }: { product: Product }) {
  const t = useTranslator();
  const { reportSessionEnded } = useAuth();
  const queryClient = useQueryClient();

  const [target, setTarget] = useState<LifecycleStatus | null>(null);

  const submit = useMutation({
    mutationFn: (status: LifecycleStatus) => setProductLifecycle(product.id, status),
    onSuccess: () => {
      /**
       * The catalog changed, and so did what the shop can operate on: archived
       * merchandise leaves the current-stock list, and discontinued merchandise
       * stops being offered for receiving. Both reads come from the server, so
       * both are invalidated rather than filtered here — the backend remains
       * the authority on which merchandise is operational.
       */
      void queryClient.invalidateQueries({ queryKey: catalogProductsQueryKey }).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: inventoryBalancesQueryKey }).catch(() => {});
      setTarget(null);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) reportSessionEnded();
    },
  });

  /**
   * Where this merchandise can go from where it is.
   *
   * The server's transition matrix, offered rather than explained: forward
   * through the lifecycle, and one step back. `ARCHIVED → ACTIVE` is absent
   * because the server refuses it — coming back into use and being restocked
   * again are two decisions — so archived merchandise is offered
   * "Discontinued" and somebody makes the second choice separately.
   */
  const options: readonly LifecycleStatus[] =
    product.lifecycleStatus === 'ACTIVE'
      ? ['DISCONTINUED', 'ARCHIVED']
      : product.lifecycleStatus === 'DISCONTINUED'
        ? ['ACTIVE', 'ARCHIVED']
        : ['DISCONTINUED'];

  return (
    <>
      <label className="sr-only" htmlFor={`lifecycle-${product.id}`}>
        {t('catalog.lifecycleFor', { product: product.name })}
      </label>
      <select
        id={`lifecycle-${product.id}`}
        className="min-h-11 rounded-md border border-line-strong bg-surface px-2 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus"
        value=""
        onChange={(event) => setTarget(event.target.value as LifecycleStatus)}
      >
        <option value="">{t('catalog.lifecycleChange')}</option>
        {options.map((status) => (
          <option key={status} value={status}>
            {t(OPTION_KEYS[status])}
          </option>
        ))}
      </select>

      {target !== null && (
        <ConfirmDialog
          title={t(OPTION_KEYS[target])}
          confirmLabel={t(OPTION_KEYS[target])}
          /* Archiving is the one that takes merchandise out of daily use, so it
             is the one that looks like it. Discontinuing and restoring are
             ordinary decisions. */
          tone={target === 'ARCHIVED' ? 'danger' : 'primary'}
          busy={submit.isPending}
          onConfirm={() => submit.mutate(target)}
          onCancel={() => {
            submit.reset();
            setTarget(null);
          }}
        >
          <p className="font-semibold">{product.name}</p>
          {/* What the status actually means for the shop, before it is chosen —
              not what it is called. */}
          <p className="text-pretty">{t(CONSEQUENCE_KEYS[target])}</p>

          {/* "Cannot archive while stock remains" is a business answer rather
              than a failure, and is shown as one — in its own words. The shared
              notice reads a bare `CONFLICT` as "the item or the location is
              closed", which is true of receiving and removal and is the wrong
              sentence here: the merchandise is not closed, it still has units
              on a shelf, and the remedy is to sell or correct them. */}
          {submit.isError &&
            (isStockConflict(target, submit.error) ? (
              <p
                role="alert"
                className="rounded-md border border-danger bg-danger-soft px-3.5 py-3 text-[15px] font-semibold text-danger-ink"
              >
                {t('catalog.archiveBlockedByStock')}
              </p>
            ) : (
              <ErrorNotice error={submit.error} />
            ))}
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * The one refusal this control says something specific about: archiving was
 * refused because units remain.
 *
 * Narrowed to the archive attempt rather than to any `409`, because the other
 * two transitions can only conflict for reasons this sentence would misdescribe
 * — and a wrong-but-confident message is worse than a general one. Everything
 * else goes to the shared `ErrorNotice`, which already handles `401`, `403`,
 * and the unexpected.
 *
 * The server is the authority on whether stock remains; this only decides which
 * sentence to read out. It still offers no way to write the stock off, because
 * a lifecycle change must never post an inventory movement.
 */
function isStockConflict(target: LifecycleStatus | null, error: unknown): boolean {
  return (
    target === 'ARCHIVED' &&
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === 'CONFLICT'
  );
}

const OPTION_KEYS: Readonly<Record<LifecycleStatus, MessageKey>> = {
  ACTIVE: 'catalog.lifecycleMakeActive',
  DISCONTINUED: 'catalog.lifecycleMakeDiscontinued',
  ARCHIVED: 'catalog.lifecycleMakeArchived',
};

const CONSEQUENCE_KEYS: Readonly<Record<LifecycleStatus, MessageKey>> = {
  ACTIVE: 'catalog.lifecycleActiveMeans',
  DISCONTINUED: 'catalog.lifecycleDiscontinuedMeans',
  ARCHIVED: 'catalog.lifecycleArchivedMeans',
};
