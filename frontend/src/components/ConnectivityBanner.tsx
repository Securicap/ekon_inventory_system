import { useEffect, useState } from 'react';
import { createTranslator, type Locale } from '../i18n/index.js';

/**
 * A persistent, unmissable banner when the browser loses connectivity.
 *
 * The requirement it satisfies is narrow but important: connectivity failures
 * must be communicated clearly, and nothing typed may be silently lost. The
 * banner covers the first half; form drafts in `lib/operations.ts` cover the
 * second.
 */
export function ConnectivityBanner({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [showRestored, setShowRestored] = useState(false);

  useEffect(() => {
    const goOnline = (): void => {
      setOnline(true);
      setShowRestored(true);
      window.setTimeout(() => setShowRestored(false), 4000);
    };
    const goOffline = (): void => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (online && !showRestored) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        online
          ? 'w-full bg-emerald-700 px-4 py-3 text-center text-base font-medium text-white'
          : 'w-full bg-amber-600 px-4 py-3 text-center text-base font-medium text-white'
      }
    >
      {online ? t('connectivity.online') : t('connectivity.offline')}
    </div>
  );
}
