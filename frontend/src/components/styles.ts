/**
 * The shared control styles: a handful of class strings, one per control the
 * application actually has.
 *
 * This is deliberately not a component library. Every string here answers a
 * question the interface already asks — how does a primary action look, a
 * secondary one, a destructive one, a navigation entry, a field — and nothing
 * here anticipates a control that does not exist yet. The colours are the theme
 * variables in `index.css`; no component picks a shade of its own.
 *
 * Two properties are not negotiable whatever else changes:
 *
 *  - controls are at least `--spacing-touch` (48px) tall, because this is used
 *    at a counter, sometimes on a tablet, sometimes in a hurry;
 *  - focus is visible on every one of them — 2px solid, offset 2px, in the
 *    focus accent — and it stays on `focus-visible`, so a mouse press does not
 *    draw a ring but a Tab key always does.
 */

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus';

/** The one action a screen is for. There is at most one per form. */
export const PRIMARY_BUTTON =
  `inline-flex min-h-touch items-center justify-center rounded-md border border-accent ` +
  `bg-accent px-[18px] py-2 text-base font-semibold text-white hover:bg-accent-hover ` +
  `disabled:border-line disabled:bg-canvas disabled:text-ink-disabled ${FOCUS}`;

/** Everything else that is safe to press: refresh, cancel, add a row, sign out. */
export const SECONDARY_BUTTON =
  `inline-flex min-h-touch items-center justify-center rounded-md border border-line-strong ` +
  `bg-surface px-4 py-2 text-base font-medium text-ink hover:bg-fill ` +
  `disabled:border-line disabled:bg-canvas disabled:text-ink-disabled ${FOCUS}`;

/**
 * Recording that stock left the shop. Distinct by weight and wording as much as
 * by colour — the restrained red is a confirmation that this button writes a
 * movement, not a warning that the application is dangerous.
 */
export const DESTRUCTIVE_BUTTON =
  `inline-flex min-h-touch items-center justify-center rounded-md border border-danger ` +
  `bg-danger px-[18px] py-2 text-base font-semibold text-white hover:bg-danger/90 ` +
  `disabled:border-line disabled:bg-canvas disabled:text-ink-disabled ${FOCUS}`;

/**
 * A navigation destination, in the sidebar and in the mobile panel alike.
 *
 * The current destination is marked by three things at once — a 3px left rule,
 * a tinted fill, and heavier text — because `aria-current` already carries the
 * semantics and colour alone would carry nothing to somebody who cannot see it.
 * The caller supplies the height, which differs between a mouse and a thumb.
 */
export const NAV_ITEM =
  `flex w-full items-center rounded-r-md border-l-[3px] border-transparent px-2.5 py-2 ` +
  `text-left text-base font-medium text-ink hover:bg-fill ` +
  `aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft ` +
  `aria-[current=page]:font-semibold aria-[current=page]:text-accent-ink ${FOCUS}`;

/** Text inputs, number inputs, and selects, which all have to line up. */
export const TEXT_INPUT =
  `block min-h-touch w-full rounded-md border border-line-strong bg-surface px-3 py-2 ` +
  `text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-2 ` +
  `aria-[invalid=true]:border-danger disabled:border-line disabled:bg-canvas ` +
  `disabled:text-ink-disabled ${FOCUS}`;
