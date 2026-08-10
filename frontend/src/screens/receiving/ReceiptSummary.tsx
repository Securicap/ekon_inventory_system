import { PANEL } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import type { VariantChoice } from '../../lib/receiving.js';

/**
 * What is about to be written, restated beside the form.
 *
 * A review surface and not a second form: nothing here is editable, and nothing
 * here is fetched. Every value is one the person just chose, so this cannot
 * disagree with what will be sent.
 *
 * Deliberately absent: what is on the shelf now. This screen reads the catalog
 * and the locations and nothing else, and a stock figure here would be a third
 * request made to decorate a command that does not depend on it — one more
 * thing to be slow, to fail, and to be stale by the time the receipt is
 * written. What is on the shelf after the delivery is the server's answer, and
 * the confirmation is where it belongs. The quantity shown here is the one
 * being added, with a `+` in front of it, because that is the whole of what
 * this command does.
 *
 * The operation id is not shown. It is how the ledger refuses to write twice,
 * not something an employee can act on; the sentence at the bottom says what it
 * guarantees without printing it.
 */
export function ReceiptSummary({
  choice,
  locationName,
  quantity,
  children,
}: {
  choice: VariantChoice | undefined;
  locationName: string;
  /** The typed quantity, as a whole number, or `null` if it is not one yet. */
  quantity: number | null;
  /** The submit control, which belongs to the form this panel sits inside. */
  children: React.ReactNode;
}) {
  const t = useTranslator();
  const missing = <span className="font-normal text-ink-muted">{t('receiving.notChosen')}</span>;

  return (
    <aside className={`${PANEL} flex flex-col gap-3.5 shadow-panel`}>
      <p className="text-xs font-bold tracking-[0.1em] text-accent uppercase">
        {t('receiving.summaryTitle')}
      </p>

      <p className="tabular text-[44px] leading-none font-bold text-ink">
        {quantity === null ? '—' : `+${quantity}`}
      </p>

      {/* Label above value rather than beside it. The panel is 344px and
          "Emplacement d'arrivée" is most of that on its own — a two-column
          layout would leave the answer a narrow ribbon down the right. */}
      <dl className="flex flex-col gap-2.5 text-sm">
        <div>
          <dt className="text-ink-soft">{t('receiving.variant')}</dt>
          <dd className="font-semibold text-ink">
            {choice === undefined
              ? missing
              : choice.attributes === ''
                ? choice.productName
                : `${choice.productName} — ${choice.attributes}`}
          </dd>
        </div>

        <div>
          <dt className="text-ink-soft">{t('catalog.sku')}</dt>
          <dd className="tabular font-semibold text-ink">{choice?.sku ?? missing}</dd>
        </div>

        <div>
          <dt className="text-ink-soft">{t('receiving.location')}</dt>
          <dd className="font-semibold text-ink">{locationName === '' ? missing : locationName}</dd>
        </div>
      </dl>

      {children}

      <p className="text-sm text-pretty text-ink-soft">{t('receiving.operationIdNote')}</p>
    </aside>
  );
}
