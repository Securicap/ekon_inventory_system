/**
 * How a variant's attributes are said to a person, in one place.
 *
 * Receiving needs them inside a single `<option>` label; the stock screen needs
 * them as their own line under the product name. Both need the same words in
 * the same order, and a shop that reads "gwosè: 5 mamit" on one screen and
 * "5 mamit (gwosè)" on the other is a shop being asked to notice that they are
 * the same item.
 */

/**
 * `gwosè: 5 mamit, mak: Tchako` — or an empty string for a variant that has no
 * attributes, which is the ordinary case for a product sold one way.
 *
 * The words are the shop's own, entered when the product was created, so they
 * are shown as they were typed and are never translated. The order is the
 * catalog's deterministic one, which the server has already applied.
 */
export function formatVariantAttributes(
  attributes: ReadonlyArray<{ name: string; value: string }>,
): string {
  return attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(', ');
}
