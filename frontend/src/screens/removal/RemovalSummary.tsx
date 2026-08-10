import { PANEL } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import type { RemovableVariantChoice } from '../../lib/removal.js';

/**
 * The removal that is about to be sent, restated beside the form.
 *
 * A review surface and not a second form: nothing here is editable, and nothing
 * here is fetched. Every value is one the person just chose, so this cannot
 * disagree with what will go on the wire.
 *
 * It is receiving's summary panel's sibling rather than the same component, and
 * the differences are the reason. The quantity is written `−6` because this
 * command takes stock away, and the number is in the danger ink for the same
 * reason. The location is the shelf stock comes **off**, which is a different
 * question from receiving's counter and is labelled as one. The reason a unit
 * left has no counterpart in receiving at all, and it is the field that becomes
 * a permanent claim about the business — sold, broken, or used — so it is
 * restated here rather than left to a dropdown that has scrolled away.
 *
 * Deliberately absent: any projection of what the shelf will hold afterwards.
 * The screen knows what the last balance read said, and subtracting one from the
 * other in a browser would put a number on screen that nothing has promised. The
 * quantity that remains is the server's answer, and the confirmation is where it
 * belongs.
 *
 * The operation id is not shown. It is how the ledger refuses to write twice,
 * not something an employee can act on; the sentence at the bottom says what it
 * guarantees without printing it.
 */
export function RemovalSummary({
  choice,
  locationName,
  quantity,
  reasonLabel,
  occurredAtLocal,
  children,
}: {
  choice: RemovableVariantChoice | undefined;
  locationName: string;
  /** The typed quantity, as a whole number, or `null` if it is not one yet. */
  quantity: number | null;
  /** The chosen reason in words, or an empty string before one is chosen. */
  reasonLabel: string;
  /** Exactly what the control holds — local time, shown as it was entered. */
  occurredAtLocal: string;
  /** The submit control, which belongs to the form this panel sits inside. */
  children: React.ReactNode;
}) {
  const t = useTranslator();
  const missing = <span className="font-normal text-ink-muted">{t('removal.notChosen')}</span>;

  return (
    <aside className={`${PANEL} flex flex-col gap-3.5 shadow-panel`}>
      <p className="text-xs font-bold tracking-[0.1em] text-danger uppercase">
        {t('removal.summaryTitle')}
      </p>

      {/* The minus is part of the number rather than a colour: a screen reader
          and a monochrome screen both read "minus six". */}
      <p className="tabular text-[44px] leading-none font-bold text-danger-ink">
        {quantity === null ? '—' : `−${quantity}`}
      </p>

      {/* Label above value rather than beside it. The panel is 344px and
          "Emplacement de sortie" is most of that on its own — a two-column
          layout would leave the answer a narrow ribbon down the right. */}
      <dl className="flex flex-col gap-2.5 text-sm">
        <div>
          <dt className="text-ink-soft">{t('removal.variant')}</dt>
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
          <dt className="text-ink-soft">{t('removal.location')}</dt>
          <dd className="font-semibold text-ink">{locationName === '' ? missing : locationName}</dd>
        </div>

        <div>
          <dt className="text-ink-soft">{t('removal.reason')}</dt>
          <dd className="font-semibold text-ink">{reasonLabel === '' ? missing : reasonLabel}</dd>
        </div>

        <div>
          <dt className="text-ink-soft">{t('removal.occurredAt')}</dt>
          <dd className="tabular font-semibold text-ink">
            {occurredAtLocal === '' ? missing : occurredAtLocal.replace('T', ' ')}
          </dd>
        </div>
      </dl>

      {children}

      <p className="text-sm text-pretty text-ink-soft">{t('removal.operationIdNote')}</p>
    </aside>
  );
}
