import type { ReactNode } from 'react';

/**
 * The top of an authenticated screen: what this page is, and one line of
 * context under it.
 *
 * Every screen behind the shell opens the same way — a rule, a title that is
 * the page's `h1`, and room on the right for the one fact worth putting beside
 * it. That is the whole of the pattern, and it is a component rather than a
 * copied block so the next five screens do not each invent their own spacing.
 *
 * It is not a layout framework. It takes strings that the caller has already
 * translated, renders no controls, and knows nothing about what is below it.
 */
export function PageHeader({
  title,
  subtitle,
  aside,
}: {
  title: string;
  subtitle?: string;
  /** One short fact, right-aligned on a wide screen and wrapped under on a narrow one. */
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-5 gap-y-2 border-b border-line pb-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {subtitle !== undefined && <p className="mt-1 text-[15px] text-ink-soft">{subtitle}</p>}
      </div>

      {aside}
    </header>
  );
}
