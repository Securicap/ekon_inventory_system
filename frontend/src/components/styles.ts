/**
 * Four class strings, shared so the temporary shell is at least consistent.
 *
 * This is not a design system and is not the beginning of one. The platform's
 * visual identity has not been designed; these exist so that a button looks
 * like a button and a focus ring is visible on every control, and they are
 * expected to be deleted whole when the real design arrives.
 *
 * The one property worth keeping whatever replaces them: controls are at least
 * `--spacing-touch` tall, because this is used at a counter, sometimes on a
 * tablet, sometimes in a hurry.
 */

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700';

export const PRIMARY_BUTTON =
  `inline-flex min-h-touch items-center justify-center rounded-md bg-blue-700 px-4 py-2 ` +
  `text-base font-medium text-white hover:bg-blue-800 disabled:bg-slate-400 ${FOCUS}`;

export const SECONDARY_BUTTON =
  `inline-flex min-h-touch items-center justify-center rounded-md border border-slate-300 ` +
  `bg-white px-3 py-2 text-base font-medium text-slate-900 hover:bg-slate-100 ` +
  `disabled:text-slate-400 ${FOCUS}`;

export const NAV_BUTTON =
  `inline-flex min-h-touch items-center rounded-md px-3 py-2 text-base font-medium ` +
  `text-slate-700 hover:bg-slate-100 aria-[current=page]:bg-slate-200 ` +
  `aria-[current=page]:text-slate-900 ${FOCUS}`;

export const TEXT_INPUT =
  `block min-h-touch w-full rounded-md border border-slate-400 px-3 py-2 text-base ` +
  `text-slate-900 aria-[invalid=true]:border-red-700 ${FOCUS}`;
