import {
  MOVEMENT_TYPES,
  type ListInventoryBalancesResponse,
  type MovementType,
} from '@ekon/shared';
import { FIELD_LABEL, TEXT_INPUT } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import type { MovementFilters } from '../../lib/movementsApi.js';
import { movementTypeKey } from '../../lib/movements.js';
import { formatVariantLabel } from '../../lib/variants.js';

/**
 * Narrowing the ledger: which item, which shelf, what kind of change.
 *
 * **No uuid ever appears on screen.** The API filters by variant and location
 * id, which is right — ids are permanent and names are not — but nobody at a
 * counter can be asked to type one. So the choices are the merchandise and the
 * shelves from the stock read, labelled the way they are labelled everywhere
 * else, and the id goes over the wire without being shown.
 *
 * Three filters and no more. A date range is the obvious fourth and is
 * deliberately absent: the feed is newest-first and the answer to "what
 * happened on Tuesday" is to scroll, which for one shop's ledger is a page or
 * two. A date picker that nobody needed would be two more controls between
 * somebody and the row they are looking for.
 */
export function HistoryFilters({
  filters,
  balances,
  onChange,
}: {
  filters: MovementFilters;
  balances: ListInventoryBalancesResponse;
  onChange: (next: MovementFilters) => void;
}) {
  const t = useTranslator();

  /**
   * Every location any variant is held at, once each.
   *
   * The balance response repeats the same locations under every variant, which
   * is right for a grid and wrong for a picker.
   */
  const locations = new Map<string, string>();
  for (const variant of balances) {
    for (const location of variant.locations)
      locations.set(location.locationId, location.locationName);
  }

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="flex min-w-56 flex-1 flex-col gap-1">
        <label htmlFor="history-variant" className={FIELD_LABEL}>
          {t('history.filterItem')}
        </label>
        <select
          id="history-variant"
          className={TEXT_INPUT}
          value={filters.variantId ?? ''}
          onChange={(event) => onChange({ ...filters, variantId: event.target.value || undefined })}
        >
          <option value="">{t('history.filterAllItems')}</option>
          {balances.map((variant) => (
            <option key={variant.variantId} value={variant.variantId}>
              {formatVariantLabel(variant.productName, variant.attributes, variant.sku)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-44 flex-col gap-1">
        <label htmlFor="history-location" className={FIELD_LABEL}>
          {t('history.filterLocation')}
        </label>
        <select
          id="history-location"
          className={TEXT_INPUT}
          value={filters.locationId ?? ''}
          onChange={(event) =>
            onChange({ ...filters, locationId: event.target.value || undefined })
          }
        >
          <option value="">{t('history.filterAllLocations')}</option>
          {[...locations].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-44 flex-col gap-1">
        <label htmlFor="history-type" className={FIELD_LABEL}>
          {t('history.filterType')}
        </label>
        <select
          id="history-type"
          className={TEXT_INPUT}
          value={filters.movementType ?? ''}
          onChange={(event) =>
            onChange({
              ...filters,
              movementType: (event.target.value as MovementType) || undefined,
            })
          }
        >
          <option value="">{t('history.filterAllTypes')}</option>
          {/* The vocabulary itself, translated for display. A type this build
              has never heard of cannot appear, because the list is the shared
              constant rather than whatever the last page happened to contain. */}
          {MOVEMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(movementTypeKey(type))}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
