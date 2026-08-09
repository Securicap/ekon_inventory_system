import { useSyncExternalStore } from 'react';

/**
 * Which shell chrome to draw: a sidebar, a rail, or a phone.
 *
 * The three presentations are different markup, not one markup with things
 * hidden — a bottom bar and a 248px sidebar are not the same element at two
 * sizes, and rendering both and hiding one would put every destination in the
 * document twice, which is two announcements for a screen reader and two
 * elements for a test to find. So exactly one is mounted, and this decides
 * which.
 *
 * The two queries are the Tailwind `md` and `lg` breakpoints, deliberately, so
 * the chrome and the content padding change at the same width.
 *
 * Where `matchMedia` does not exist — jsdom, and any non-browser render — this
 * answers `desktop`. That is the presentation with every destination visible
 * and no panel to open, so a caller that cannot measure the viewport still gets
 * a complete, usable shell rather than a phone bar.
 */
export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const MOBILE = '(max-width: 767px)';
const TABLET = '(min-width: 768px) and (max-width: 1023px)';

function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function read(): Breakpoint {
  if (!supported()) return 'desktop';
  if (window.matchMedia(MOBILE).matches) return 'mobile';
  if (window.matchMedia(TABLET).matches) return 'tablet';
  return 'desktop';
}

function subscribe(onChange: () => void): () => void {
  if (!supported()) return () => {};
  const lists = [window.matchMedia(MOBILE), window.matchMedia(TABLET)];
  for (const list of lists) list.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list.removeEventListener('change', onChange);
  };
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, read, () => 'desktop');
}
