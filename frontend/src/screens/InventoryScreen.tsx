import type { ListInventoryLocationsResponse } from '@ekon/shared';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useTranslator } from '../i18n/index.js';
import { api } from '../lib/api.js';

/**
 * Inventory locations, read-only — which is the whole of the inventory API
 * today. Quantities arrive with receiving, and receiving is a later PR.
 *
 * Behaves exactly as the catalog screen does about permissions: the request is
 * protected by `inventory.read` on the server, and a `403` is shown in place
 * rather than treated as a session problem.
 */
export function InventoryScreen() {
  const t = useTranslator();

  const locations = useProtectedQuery({
    queryKey: ['inventory', 'locations'],
    queryFn: ({ signal }) =>
      api.get<ListInventoryLocationsResponse>('/api/inventory/locations', signal),
  });

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-medium">{t('inventory.title')}</h2>

      {locations.isPending && <p className="text-slate-600">{t('status.loading')}</p>}

      {locations.isError && <ErrorNotice error={locations.error} />}

      {locations.data?.length === 0 && <p className="text-slate-600">{t('inventory.empty')}</p>}

      {locations.data && locations.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {locations.data.map((location) => (
            <li
              key={location.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4"
            >
              <span className="font-medium">{location.name}</span>
              {location.isDefault && (
                <span className="rounded bg-slate-100 px-2 py-1 text-sm text-slate-700">
                  {t('inventory.defaultLocation')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
