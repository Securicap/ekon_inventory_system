import ht from './ht.json';
import fr from './fr.json';

/**
 * Two locales, no framework.
 *
 * Haitian Creole is the primary employee-facing language: a user entering
 * inventory in a second language makes more mistakes, and a mistake in an
 * append-only ledger is permanent and needs a compensating movement to fix.
 * French is available for the owner.
 *
 * Retrofitting translation after screens exist is a refactor of every
 * component, so it goes in from the first screen. A typed lookup is all this
 * needs; an i18n library would be a dependency solving no problem we have.
 */

export const LOCALES = ['ht', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ht';

const catalogs: Record<Locale, Record<string, string>> = { ht, fr };

/** Keys are constrained to those defined in the primary catalogue. */
export type MessageKey = keyof typeof ht;

export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const template = catalogs[locale][key] ?? catalogs[DEFAULT_LOCALE][key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function createTranslator(locale: Locale) {
  return (key: MessageKey, vars?: Record<string, string | number>): string =>
    translate(locale, key, vars);
}

export type Translator = ReturnType<typeof createTranslator>;

/**
 * The translator a component should use.
 *
 * Every locale-bearing component goes through this one call, so the day a
 * locale becomes a preference rather than a constant — a stored choice, or the
 * owner reading French while the counter reads Creole — it is this function
 * that grows a context, and not every component that renders a string. There is
 * no language selector yet, and adding one is not this PR's work.
 */
export function useTranslator(): Translator {
  return createTranslator(DEFAULT_LOCALE);
}

/**
 * Every timestamp is displayed in shop time for every user, everywhere — so the
 * owner abroad and the employee at the counter never read the same movement as
 * two different dates.
 */
export const SHOP_TIMEZONE = 'America/Port-au-Prince';

export function formatShopTime(value: string | Date, locale: Locale = DEFAULT_LOCALE): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === 'ht' ? 'fr-HT' : 'fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: SHOP_TIMEZONE,
  }).format(date);
}
