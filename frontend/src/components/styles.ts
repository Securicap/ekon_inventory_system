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

/**
 * The ring on a region that is focused by code rather than by a key press.
 *
 * `focus-visible` is a heuristic about *how* focus arrived, and a
 * `tabIndex={-1}` container that a screen focuses after an answer comes back
 * does not reliably satisfy it — so the panel takes focus with nothing drawn
 * around it, which is exactly the moment somebody on a keyboard needs to see
 * where they have been sent. Plain `:focus`, deliberately, and only for that
 * case: these containers are not in the tab order, so the ring can never appear
 * from an ordinary Tab or a mouse press.
 */
export const OUTCOME_FOCUS = 'focus:outline-2 focus:outline-offset-2 focus:outline-accent-focus';

/**
 * A white panel on the application canvas: the one container a screen has.
 *
 * There is no card variant, no elevated variant, and no header slot. A screen
 * that needs a second kind of box almost always needs a second heading instead.
 */
export const PANEL = 'rounded-lg border border-line bg-surface p-6';

const BUTTON = `inline-flex min-h-touch items-center justify-center rounded-md border py-2 ${FOCUS}`;

/** Unpressable because something else must happen first: grey, and inert. */
const DISABLED = 'disabled:border-line disabled:bg-canvas disabled:text-ink-disabled';

const PRIMARY_LOOK = 'border-accent bg-accent px-[18px] text-base font-semibold text-white';

/** The one action a screen is for. There is at most one per form. */
export const PRIMARY_BUTTON = `${BUTTON} ${PRIMARY_LOOK} hover:bg-accent-hover ${DISABLED}`;

/**
 * The same button while its own command is in flight.
 *
 * Deliberately not the disabled look. "You may not press this" and "this is
 * working on what you pressed" are different facts, and a grey button says the
 * first when the second is true. It keeps its colour, dims, and carries its own
 * progress mark — so the only thing that changed is that it is busy. The
 * disabled utilities are absent rather than overridden, because two `disabled:`
 * rules for one property would be settled by stylesheet order.
 */
export const PRIMARY_BUTTON_BUSY = `${BUTTON} ${PRIMARY_LOOK} cursor-progress opacity-75`;

/** Everything else that is safe to press: refresh, cancel, add a row, sign out. */
export const SECONDARY_BUTTON =
  `${BUTTON} border-line-strong bg-surface px-4 text-base font-medium text-ink ` +
  `hover:bg-fill ${DISABLED}`;

/**
 * Recording that stock left the shop. Distinct by weight and wording as much as
 * by colour — the restrained red is a confirmation that this button writes a
 * movement, not a warning that the application is dangerous.
 */
const DESTRUCTIVE_LOOK = 'border-danger bg-danger px-[18px] text-base font-semibold text-white';

export const DESTRUCTIVE_BUTTON = `${BUTTON} ${DESTRUCTIVE_LOOK} hover:bg-danger/90 ${DISABLED}`;

/**
 * The same button while its own command is in flight — `PRIMARY_BUTTON_BUSY`'s
 * one-line equivalent, and it exists for the same reason and one more.
 *
 * Grey is what "you may not press this" looks like, and a removal that is *in
 * progress* is the moment its meaning matters most: somebody waiting to hear
 * whether stock came off a shelf must not be shown a button that has stopped
 * looking like the button they pressed. So it keeps the danger colour, dims,
 * and carries its own progress mark.
 */
export const DESTRUCTIVE_BUTTON_BUSY = `${BUTTON} ${DESTRUCTIVE_LOOK} cursor-progress opacity-75`;

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

/**
 * The three pieces of text around a field: its label, the hint under it, and
 * the reason it was refused.
 *
 * A label is always visible and always a `<label>`; a placeholder is not a
 * label and is never used as one. The hint and the error are the same size on
 * purpose — one of them replacing the other must not move the form.
 */
export const FIELD_LABEL = 'text-[15px] font-semibold text-ink';
export const FIELD_HINT = 'text-sm text-ink-soft';
export const FIELD_ERROR = 'text-sm font-semibold text-danger-ink';

/** Text inputs, number inputs, and selects, which all have to line up. */
export const TEXT_INPUT =
  `block min-h-touch w-full rounded-md border border-line-strong bg-surface px-3 py-2 ` +
  `text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-2 ` +
  `aria-[invalid=true]:border-danger disabled:border-line disabled:bg-canvas ` +
  `disabled:text-ink-disabled ${FOCUS}`;
