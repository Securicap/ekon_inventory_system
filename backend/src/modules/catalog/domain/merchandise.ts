/**
 * Merchandise identity, for the things a shop names: brands and classification
 * values.
 *
 * One rule, applied in one place, and the same one the catalog already uses for
 * attribute values (see `variantSignature.ts`): **identity is case-insensitive,
 * display case is the shop's.** `Steve Madden`, `steve madden`, and
 * `STEVE MADDEN` are one brand; the one the shop reads back is whichever it
 * entered first.
 *
 * The database stores both forms — a display column and a normalized column
 * tied to it by a CHECK (0009) — so this function decides what goes in the
 * second one, and the constraint makes sure nothing else can.
 *
 * Lower-casing is `String.prototype.toLowerCase()`: ordinary, locale-independent
 * Unicode case mapping, which is what PostgreSQL's `lower()` does for the
 * Latin-script names this catalog holds.
 */
export function normalizeMerchandiseName(name: string): string {
  return name.trim().toLowerCase();
}

/** The display form: trimmed, case preserved. What is stored and returned. */
export function displayMerchandiseName(name: string): string {
  return name.trim();
}
