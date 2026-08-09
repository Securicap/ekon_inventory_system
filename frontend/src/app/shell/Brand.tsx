import { useTranslator } from '../../i18n/index.js';

/**
 * The application's identity: a wordmark and the line that says what this is.
 *
 * Both come from the catalogue — the wordmark is `app.name`, capitalised by CSS
 * rather than by the component, so what a screen reader announces and what a
 * test looks for is still the application's name and not a shouted variant of
 * it. The shell carries no text the rest of the application cannot translate.
 */
export function Brand({ variant = 'full' }: { variant?: 'full' | 'wordmark' | 'compact' }) {
  const t = useTranslator();
  const name = t('app.name');

  if (variant === 'compact') {
    // The 72px tablet rail has room for a mark, not for a word. The full name
    // stays in the accessibility tree.
    return (
      <p className="text-[17px] font-bold tracking-[0.02em] text-ink uppercase">
        <span aria-hidden="true">{name.slice(0, 2)}</span>
        <span className="sr-only">{name}</span>
      </p>
    );
  }

  if (variant === 'wordmark') {
    return <p className="text-[17px] font-bold tracking-[0.12em] text-ink uppercase">{name}</p>;
  }

  return (
    <div>
      <p className="text-[19px] font-bold tracking-[0.14em] text-ink uppercase">{name}</p>
      <p className="text-xs text-ink-muted">{t('app.tagline')}</p>
    </div>
  );
}
