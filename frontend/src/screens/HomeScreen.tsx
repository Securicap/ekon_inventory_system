import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@ekon/shared';
import { useAuthenticatedUser } from '../auth/useAuth.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { formatShopTime, useTranslator } from '../i18n/index.js';
import { api } from '../lib/api.js';

/**
 * The landing view: who you are, and whether the system is healthy.
 *
 * The health panel is the Sprint 0 screen, kept rather than replaced. It is the
 * only thing in the application that has ever proved browser → Fastify →
 * Postgres end to end, and it is still the fastest way to tell whether a deploy
 * is serving the schema it thinks it is.
 *
 * What is deliberately not here is a dashboard. Stock on hand, low-stock counts,
 * movements today — every one of those is a number the business would read as
 * true, and none of the workflows that produce them exists yet.
 */
export function HomeScreen() {
  const t = useTranslator();
  const user = useAuthenticatedUser();

  // Public: `/api/health` needs no session, so it is an ordinary query rather
  // than a protected one, and a 401 is not among its answers.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.get<HealthResponse>('/api/health', signal),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-medium">{t('home.welcome', { name: user.displayName })}</h2>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-medium">{t('health.title')}</h3>

        {health.isPending && <p className="text-slate-600">{t('status.loading')}</p>}

        {/* An unreachable server and a 503 from a database that is down are
            different sentences, and the panel exists to tell them apart. */}
        {health.isError && (
          <ErrorNotice error={health.error} onRetry={() => void health.refetch()} />
        )}

        {health.data && (
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-slate-600">{t('health.database')}</dt>
            <dd className="tabular font-medium">
              {health.data.database === 'up' ? t('health.up') : t('health.down')}
            </dd>

            <dt className="text-slate-600">{t('health.schemaVersion')}</dt>
            <dd className="tabular font-medium">{health.data.schemaVersion ?? '—'}</dd>

            <dt className="text-slate-600">{t('health.version')}</dt>
            <dd className="tabular font-medium">{health.data.version}</dd>

            <dt className="text-slate-600">{t('health.time')}</dt>
            <dd className="tabular font-medium">{formatShopTime(health.data.time)}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}
