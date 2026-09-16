/**
 * A short word about the state of something: a lifecycle, a count, a variance.
 *
 * **The word is the whole message.** The colour is a second way of saying the
 * same thing for the people it reaches, and never the only way — somebody who
 * cannot tell the amber chip from the grey one reads "Discontinued" and
 * "Archived" and is told exactly as much as anybody else. That rule is why this
 * takes a label rather than a status and a lookup table: a chip with no text is
 * not a state this component can be asked to render.
 *
 * Four tones, and they are semantic rather than decorative:
 *
 *   `neutral`   a fact with no urgency — archived merchandise, a settled count.
 *   `positive`  the shelf and the record agree.
 *   `attention` something a person needs to look at: a discrepancy, merchandise
 *               that is no longer replenished.
 *   `critical`  stock left, or a record was corrected downward.
 */
export type ChipTone = 'neutral' | 'positive' | 'attention' | 'critical';

const TONES: Readonly<Record<ChipTone, string>> = {
  neutral: 'border-line-strong bg-fill text-ink-soft',
  positive: 'border-success bg-success-soft text-success-ink',
  attention: 'border-warning bg-warning-soft text-warning-ink',
  critical: 'border-danger bg-danger-soft text-danger-ink',
};

export function StatusChip({ label, tone = 'neutral' }: { label: string; tone?: ChipTone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${TONES[tone]}`}
    >
      {label}
    </span>
  );
}
