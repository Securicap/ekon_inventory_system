import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@ekon/shared';
import { ConnectivityBanner } from '../components/ConnectivityBanner.js';
import { createTranslator, DEFAULT_LOCALE, formatShopTime } from '../i18n/index.js';
import { api } from '../lib/api.js';

/**
 * Sprint 0 shell.
 *
 * This screen exists to prove the whole path end to end — browser to Fastify to
 * Postgres and back — on the real deployment, before any business feature is
 * built. It is replaced by the stock overview in a later PR.
 */
export function App() {
  const locale = DEFAULT_LOCALE;
  const t = createTranslator(locale);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.get<HealthResponse>('/api/health', signal),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex min-h-full flex-col bg-slate-50 text-slate-900">
      <ConnectivityBanner locale={locale} />

      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-xl font-semibold">{t('app.name')}</h1>
        <p className="text-sm text-slate-600">{t('app.tagline')}</p>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-medium">{t('health.title')}</h2>

          {health.isPending && <p className="text-slate-600">{t('status.loading')}</p>}

          {health.isError && (
            <p className="text-red-700" role="alert">
              {t('error.network')}
            </p>
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

              <dt className="text-slate-600">Lè</dt>
              <dd className="tabular font-medium">{formatShopTime(health.data.time, locale)}</dd>
            </dl>
          )}
        </section>
      </main>
    </div>
  );
}
