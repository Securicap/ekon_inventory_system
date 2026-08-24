import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@ekon/shared';
import { availableNavigation, shortcutNavigation, type View } from '../app/navigation.js';
import { hasCapability } from '../auth/capabilities.js';
import { ROLE_LABEL_KEYS } from '../auth/roles.js';
import { useAuthenticatedUser } from '../auth/useAuth.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PageHeader } from '../components/PageHeader.js';
import { PANEL, SECONDARY_BUTTON } from '../components/styles.js';
import { formatShopTime, useTranslator } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { countsQueryKey, getCounts } from '../lib/countsApi.js';

/**
 * The landing view: who you are, what you can open, and whether the system is
 * working.
 *
 * It is a starting point, not a dashboard. Stock on hand, movements today,
 * value in the shop, sales this week — every one of those is a number the
 * business would read as true, and the API produces none of them. A sparse
 * screen that says only what is known beats a full one that invents the rest,
 * because a made-up figure in an inventory system is not a placeholder, it is a
 * lie somebody will act on. There are still no charts here and no tiles with
 * totals in them.
 *
 * There is now **one** thing on it that is not a door, and it earns its place
 * by being work rather than a metric: *unexplained count differences*. It is a
 * count of open discrepancies — a number the server already keeps, that means
 * exactly one thing, and that names something a person has to go and do. No
 * threshold, no trend, no colour scale; when there are none, the panel is not
 * drawn at all.
 *
 * Otherwise: a list of doors, which is exactly the doors the shell would show —
 * same list, same capabilities, one source — and the health panel kept from
 * Sprint 0, still the fastest way to tell whether a deploy is serving the
 * schema it thinks it is.
 */
export function HomeScreen({ onNavigate }: { onNavigate: (view: View) => void }) {
  const t = useTranslator();
  const user = useAuthenticatedUser();

  // Public: `/api/health` needs no session, so it is an ordinary query rather
  // than a protected one, and a 401 is not among its answers.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.get<HealthResponse>('/api/health', signal),
    refetchInterval: 30_000,
  });

  const shortcuts = shortcutNavigation(availableNavigation(user));

  /**
   * Unresolved count differences, for somebody who may see stock at all.
   *
   * The first page of the open feed and nothing more — the length of one page
   * is enough to say "there is work here", and this screen deliberately does
   * not ask the server for a total it would then have to keep accurate. Sharing
   * the Counts screen's own query key means arriving there shows what this
   * panel counted, and reconciling one updates both.
   */
  const openCounts = useProtectedQuery({
    queryKey: countsQueryKey({ status: 'OPEN' }),
    queryFn: ({ signal }) => getCounts({ status: 'OPEN' }, null, signal),
    enabled: hasCapability(user, 'inventory.read'),
  });

  const discrepancies = openCounts.data?.items.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('home.welcome', { name: user.displayName })}
        subtitle={t('home.identity', {
          role: t(ROLE_LABEL_KEYS[user.role]),
          username: user.username,
        })}
        aside={
          /* Shop time, from the server that stamps the ledger — not from this
             device's clock, which may be in another country and wrong. It is
             absent rather than guessed at while the server is unreachable. */
          health.data && (
            <p className="tabular text-sm text-ink-soft">{formatShopTime(health.data.time)}</p>
          )
        }
      />

      {/* Only when there is something to attend to. An empty attention panel is
          a permanent reminder that nothing is wrong, which is noise. */}
      {discrepancies > 0 && (
        <section
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning bg-warning-soft px-4 py-3"
          aria-labelledby="home-attention"
        >
          <div>
            <h2 id="home-attention" className="text-[15px] font-semibold text-warning-ink">
              {t(discrepancies === 1 ? 'home.openCountsOne' : 'home.openCounts', {
                count: discrepancies,
              })}
            </h2>
            <p className="text-sm text-warning-ink">{t('home.openCountsHint')}</p>
          </div>

          <button type="button" className={SECONDARY_BUTTON} onClick={() => onNavigate('counts')}>
            {t('home.openCountsAction')}
          </button>
        </section>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[1.5fr_1fr]">
        <section className={`${PANEL} flex flex-col gap-3.5`} aria-labelledby="home-tasks">
          <h2 id="home-tasks" className="text-lg font-semibold text-ink">
            {t('home.tasks')}
          </h2>

          {/* An account with nothing granted is a real state — somebody whose
              access was taken away, or not given yet. Saying so is the point:
              a bare panel with no sentence reads as an application that broke,
              and the remedy is to ask the owner rather than to try again. */}
          {shortcuts.length === 0 && (
            <p className="text-[15px] text-pretty text-ink-soft">{t('home.noTasks')}</p>
          )}

          <ul className="flex flex-col">
            {shortcuts.map((item) => (
              <li key={item.view} className="border-b border-rule last:border-b-0">
                <button
                  type="button"
                  onClick={() => onNavigate(item.view)}
                  /* Stacked where the row is narrow, and on one line where
                     there is room. Wrapping only when a particular label
                     happens to be long would make five rows look like five
                     different designs. */
                  className="flex min-h-16 w-full flex-col items-start justify-center gap-y-0.5 rounded-md px-1 py-2 text-left hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus sm:flex-row sm:items-center sm:justify-between sm:gap-x-4"
                >
                  <span className="text-[17px] font-semibold text-ink">{t(item.labelKey)}</span>
                  {item.descriptionKey !== undefined && (
                    <span className="text-sm text-ink-soft">{t(item.descriptionKey)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>

          {shortcuts.length > 0 && (
            <p className="text-sm text-pretty text-ink-soft">{t('home.tasksNote')}</p>
          )}
        </section>

        <section className={`${PANEL} flex flex-col gap-3`} aria-labelledby="home-health">
          <h2 id="home-health" className="text-lg font-semibold text-ink">
            {t('health.title')}
          </h2>

          {health.isPending && (
            <p role="status" className="text-[15px] text-ink-soft">
              {t('status.loading')}
            </p>
          )}

          {/* An unreachable server and a 503 from a database that is down are
              different sentences, and the panel exists to tell them apart. */}
          {health.isError && (
            <ErrorNotice error={health.error} onRetry={() => void health.refetch()} />
          )}

          {health.data && (
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 text-[15px]">
              <dt className="text-ink-soft">{t('health.database')}</dt>
              {/* The state is a word, and the word is the whole message. The
                  colour under it is a second way of saying the same thing, for
                  the people it reaches. */}
              <dd
                className={
                  health.data.database === 'up'
                    ? 'font-semibold text-ink'
                    : 'font-semibold text-danger-ink'
                }
              >
                {health.data.database === 'up' ? t('health.up') : t('health.down')}
              </dd>

              <dt className="text-ink-soft">{t('health.schemaVersion')}</dt>
              <dd className="tabular font-semibold text-ink">{health.data.schemaVersion ?? '—'}</dd>

              <dt className="text-ink-soft">{t('health.version')}</dt>
              <dd className="tabular font-semibold text-ink">{health.data.version}</dd>

              <dt className="text-ink-soft">{t('health.time')}</dt>
              <dd className="tabular font-semibold text-ink">{formatShopTime(health.data.time)}</dd>
            </dl>
          )}

          <p className="text-sm text-pretty text-ink-soft">{t('home.healthNote')}</p>
        </section>
      </div>
    </div>
  );
}
