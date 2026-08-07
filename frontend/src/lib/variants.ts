/**
 * How a variant is named to a person, in one place.
 *
 * Three screens need it and none of them may disagree. Receiving and removal
 * put the whole thing inside a single `<option>`; the stock screen breaks it
 * apart, with the attributes on their own line under the product name. A shop
 * that reads "gwosè: 5 mamit" on one screen and "5 mamit (gwosè)" on the other
 * is a shop being asked to notice that they are the same item.
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

/**
 * What a variant is called on screen, as one line.
 *
 * ```text
 * Diri — gwosè: 5 mamit, mak: Tchako — EKN-AB12CD34
 * Lwil — EKN-EF56GH78
 * ```
 *
 * The SKU is included because it is the one thing printed on the shelf label,
 * so somebody holding the box can match it. The variant signature, the product
 * id, the variant id, and the timestamps are not: they identify rows to a
 * database and mean nothing to the person at the counter.
 */
export function formatVariantLabel(
  productName: string,
  attributes: ReadonlyArray<{ name: string; value: string }>,
  sku: string,
): string {
  return [productName, formatVariantAttributes(attributes), sku]
    .filter((part) => part !== '')
    .join(' — ');
}
