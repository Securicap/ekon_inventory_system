import { useTranslator } from '../i18n/index.js';

/**
 * The application's identity: a wordmark and the line that says what this is.
 *
 * One component for every surface that shows it — the sidebar, the tablet rail,
 * the mobile bar, the navigation sheet, and the screens outside the
 * authentication boundary. It lives here rather than beside the shell because
 * the login screen needs the same mark and must not reach into authenticated
 * navigation to get it.
 *
 * Both strings come from the catalogue, and the wordmark is capitalised by CSS
 * rather than by the component, so what a screen reader announces and what a
 * test looks for is still the application's name and not a shouted variant.
 *
 * `level` promotes the wordmark to the page's `h1`. Unauthenticated screens
 * pass it, because on those the identity *is* the top of the document; inside
 * the shell it stays a paragraph, and the outline belongs to the screen in
 * `main`.
 */
export function Brand({
  variant = 'full',
  level,
}: {
  variant?: 'hero' | 'full' | 'wordmark' | 'compact';
  level?: 1;
}) {
  const t = useTranslator();
  const name = t('app.name');
  const Wordmark = level === 1 ? 'h1' : 'p';

  if (variant === 'compact') {
    // The 72px tablet rail has room for a mark, not for a word. The full name
    // stays in the accessibility tree.
    return (
      <Wordmark className="text-[17px] font-bold tracking-[0.02em] text-ink uppercase">
        <span aria-hidden="true">{name.slice(0, 2)}</span>
        <span className="sr-only">{name}</span>
      </Wordmark>
    );
  }

  if (variant === 'wordmark') {
    return (
      <Wordmark className="text-[17px] font-bold tracking-[0.12em] text-ink uppercase">
        {name}
      </Wordmark>
    );
  }

  // `hero` is the same mark given the room a centred, otherwise-empty screen
  // has: larger, and with the tagline at reading size rather than as a caption.
  const wordmark = variant === 'hero' ? 'text-[22px]' : 'text-[19px]';
  const tagline = variant === 'hero' ? 'text-[15px] text-ink-soft' : 'text-xs text-ink-muted';

  return (
    <div>
      <Wordmark className={`${wordmark} font-bold tracking-[0.14em] text-ink uppercase`}>
        {name}
      </Wordmark>
      <p className={tagline}>{t('app.tagline')}</p>
    </div>
  );
}
