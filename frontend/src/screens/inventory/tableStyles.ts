/**
 * The two class strings the inventory register's cells share.
 *
 * The desktop table and the tablet table are different column structures, not
 * one table at two widths — but they are the same *register*, and a header row
 * that was compact on one and roomy on the other would read as two screens. So
 * the padding, the header treatment, and the rule between rows live here once.
 *
 * `border-separate` rather than `border-collapse` is the reason borders are on
 * cells rather than on rows: a collapsed border belongs to no element in
 * particular, and a sticky header whose underline is drawn by the collapse
 * loses it the moment it detaches. These borders travel with the cell.
 */

/**
 * A column header. Compact, uppercase, and quiet — it names the column once and
 * then gets out of the way of the numbers under it.
 *
 * `align-bottom` because "Emplacement principal" wraps to two lines where
 * "Total" does not, and headers of different heights must still sit on one
 * line at the bottom.
 */
export const HEAD =
  'sticky top-0 z-10 border-b border-line-strong bg-surface px-3 py-2.5 align-bottom ' +
  'text-xs font-bold tracking-[0.06em] text-ink-muted uppercase';

/** An ordinary cell: enough room to read a shelf name, not enough to be a card. */
export const CELL = 'border-b border-rule px-3 py-3 align-baseline';
