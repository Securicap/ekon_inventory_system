import { vi } from 'vitest';

/**
 * Pretends the browser is a phone, a tablet, or a desktop.
 *
 * jsdom has no `matchMedia` at all, which is why `useBreakpoint` answers
 * `desktop` when it is missing — every existing test therefore renders the
 * sidebar shell without knowing this file exists. A test that wants one of the
 * narrow chromes calls this *before* rendering, and `setup.ts` unstubs it
 * afterwards.
 *
 * The stub answers the two queries `useBreakpoint` asks and nothing else; it is
 * a viewport, not a CSS engine.
 */
export type Viewport = 'mobile' | 'tablet' | 'desktop';

const WIDTHS: Readonly<Record<Viewport, number>> = {
  mobile: 390,
  tablet: 834,
  desktop: 1280,
};

function matches(query: string, width: number): boolean {
  const max = /max-width:\s*(\d+)px/.exec(query)?.[1];
  const min = /min-width:\s*(\d+)px/.exec(query)?.[1];
  if (max === undefined && min === undefined) return false;
  if (max !== undefined && width > Number(max)) return false;
  if (min !== undefined && width < Number(min)) return false;
  return true;
}

export function viewport(size: Viewport): void {
  const width = WIDTHS[size];
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        media: query,
        matches: matches(query, width),
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}
