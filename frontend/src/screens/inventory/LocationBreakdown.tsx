import { Fragment } from 'react';
import type { VariantLocationBalance } from '@ekon/shared';
import { useTranslator } from '../../i18n/index.js';

/**
 * Where one variant's stock actually is: every active shelf, with the number on
 * it, inside the single record the variant occupies.
 *
 * One element, used by all three presentations, because "Main Store 18 /
 * Backroom 6" must read identically on a laptop, a tablet, and a phone. Three
 * copies of this markup would eventually become three different answers to
 * where the stock is.
 *
 * A description list rather than two columns of text: `dt` is the shelf and
 * `dd` is what is on it, so a screen reader reads each number with the name it
 * belongs to instead of announcing a row of figures floating beside a row of
 * words. The visual pairing is a two-column grid over the same elements.
 *
 * The order is the server's — default location first, then the rest as the
 * projection returned them. It is never re-sorted here: alphabetical order
 * would be a visual convenience that moved the shop's main shelf out of the
 * position the API deliberately put it in.
 */
export function LocationBreakdown({ locations }: { locations: readonly VariantLocationBalance[] }) {
  const t = useTranslator();

  /* No active location at all. An operational problem to say out loud, not a
     row to hide and not a shelf to invent. */
  if (locations.length === 0) {
    return <p className="text-[15px] text-ink-soft">{t('stock.noLocations')}</p>;
  }

  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1">
      {locations.map((location) => (
        <Fragment key={location.locationId}>
          <dt className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[15px] text-ink-soft">
            <span className="min-w-0 wrap-anywhere">{location.locationName}</span>
            {/* A word, not a colour or a dot: somebody who cannot see the
                difference reads the same marker everybody else does.

                Quiet on purpose. This is a fact about the *shelf*, not about
                the stock on it, and it repeats on almost every row — an
                uppercase chip down the whole column would shout the least
                interesting thing on the screen. Small, unbolded, and in the
                muted ink, so it reads as an aside on the name beside it. */}
            {location.isDefault && (
              <span className="rounded bg-fill px-1.5 py-px text-[11px] font-medium text-ink-muted">
                {t('inventory.defaultLocation')}
              </span>
            )}
          </dt>

          {/* Every active location, including the ones holding nothing. A zero
              is an answer — "we have none in the Main Store" — and a shelf
              dropped for being empty would read as a shelf that does not
              exist. */}
          <dd className="tabular text-right text-[15px] font-medium text-ink">
            {location.quantity}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
