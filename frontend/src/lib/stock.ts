import type { ListInventoryBalancesResponse, VariantStockBalance } from '@ekon/shared';

/**
 * Finding one item in the current-stock list.
 *
 * The search is entirely in the browser, over a response the server already
 * sent in full. For a single shop the whole active picture is a small bounded
 * list, and asking the network again for every keystroke on a connection that
 * drops would make the field unusable at exactly the counter it is for. There
 * is no search endpoint, no query parameter, and no debounce to tune.
 *
 * It is here rather than in the screen because it is a rule somebody may want
 * to check without reading JSX, and because it is worth testing directly.
 */

/**
 * Text as the search compares it: case-folded and stripped of accents, so
 * `gwose` finds `gwosè` and `MAMIT` finds `mamit`.
 *
 * Accents are dropped on both sides rather than only on the query. A shop
 * laptop's keyboard makes `è` awkward to type, and an employee who types the
 * word without it is not making a mistake worth an empty result.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * The words one variant can be found by: what it is called, what is printed on
 * its shelf label, and how it differs from its siblings.
 *
 * Location names are deliberately not searchable. "Show me everything in the
 * backroom" is a filter over locations, which is a different question with a
 * different answer shape — a substring match would answer it by hiding the
 * other locations' quantities from the rows it did return, which is worse than
 * not answering it.
 */
function searchableText(variant: VariantStockBalance): string {
  return normalizeSearchText(
    [
      variant.productName,
      variant.sku,
      ...variant.attributes.flatMap((attribute) => [attribute.name, attribute.value]),
    ].join(' '),
  );
}

/**
 * The variants a search matches, in the order the server returned them.
 *
 * An empty or whitespace-only query matches everything: a cleared field shows
 * the whole shop rather than nothing. Ordering is never changed — the response
 * is already deterministic, and re-sorting by relevance would move rows under
 * somebody's finger while they typed.
 */
export function filterStockBalances(
  balances: ListInventoryBalancesResponse,
  query: string,
): ListInventoryBalancesResponse {
  const needle = normalizeSearchText(query.trim());
  if (needle === '') return balances;
  return balances.filter((variant) => searchableText(variant).includes(needle));
}
