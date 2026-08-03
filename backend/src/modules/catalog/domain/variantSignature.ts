import type { VariantAttribute } from '@ekon/shared';

/**
 * Variant identity.
 *
 * Two variants of the same product are "the same" when they carry the same
 * attributes. To decide that in one place — and to let the database enforce it —
 * a normalized attribute set is reduced to a single deterministic string, the
 * `variant_signature`.
 *
 * Normalization rules, applied here and nowhere else, and mirrored by CHECK
 * constraints in the migration:
 *
 *   - Attribute NAMES are trimmed and lower-cased. "Color", " color ", and
 *     "COLOR" are the same attribute. Two attributes that normalize to the same
 *     name in one variant are a client error.
 *   - Attribute VALUES are trimmed only; case is preserved, because "White" and
 *     "white" are legitimately different values a shop might stock.
 *   - The set is sorted by normalized name, so input order never matters.
 *
 * The signature is the JSON of the sorted [name, value] pairs. JSON quoting
 * keeps the name/value boundary unambiguous, so `{a: "b=c"}` and `{a: "b", c:
 * ""}`-style collisions cannot occur. An empty attribute set produces `[]`, the
 * signature of a default variant.
 */

export interface NormalizedAttribute {
  name: string;
  value: string;
}

/** A blank name or value, or two names that collide after normalization. */
export class AttributeNormalizationError extends Error {
  readonly details: ReadonlyArray<{ path: string; message: string }>;
  constructor(details: ReadonlyArray<{ path: string; message: string }>) {
    super('Attribute normalization failed');
    this.name = 'AttributeNormalizationError';
    this.details = details;
  }
}

export function normalizeAttributeName(name: string): string {
  return name.trim().toLowerCase();
}

export function normalizeAttributeValue(value: string): string {
  return value.trim();
}

/**
 * Normalizes a request's `{ name: value }` attribute object into a sorted,
 * de-duplicated list. Throws {@link AttributeNormalizationError} with
 * field-level detail on a blank name/value or a post-normalization name clash.
 *
 * `pathPrefix` locates the offending variant in error messages, e.g.
 * `variants.0.attributes`.
 */
export function normalizeAttributes(
  raw: Record<string, string>,
  pathPrefix: string,
): NormalizedAttribute[] {
  const details: { path: string; message: string }[] = [];
  const byName = new Map<string, NormalizedAttribute>();

  for (const [rawName, rawValue] of Object.entries(raw)) {
    const name = normalizeAttributeName(rawName);
    const value = normalizeAttributeValue(rawValue);

    if (name === '') {
      details.push({
        path: `${pathPrefix}.${rawName}`,
        message: 'Attribute name must not be blank',
      });
      continue;
    }
    if (value === '') {
      details.push({
        path: `${pathPrefix}.${rawName}`,
        message: 'Attribute value must not be blank',
      });
      continue;
    }
    if (byName.has(name)) {
      details.push({
        path: `${pathPrefix}.${rawName}`,
        message: `Duplicate attribute name after normalization: "${name}"`,
      });
      continue;
    }
    byName.set(name, { name, value });
  }

  if (details.length > 0) throw new AttributeNormalizationError(details);

  return sortAttributes([...byName.values()]);
}

/** Sorts attributes deterministically by normalized name. */
export function sortAttributes(attributes: NormalizedAttribute[]): NormalizedAttribute[] {
  return [...attributes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Builds the deterministic signature from a normalized attribute list. The same
 * attributes in any order yield the same signature; different values yield
 * different signatures; an empty set yields `[]`.
 */
export function buildVariantSignature(attributes: NormalizedAttribute[]): string {
  const pairs = sortAttributes(attributes).map(({ name, value }): [string, string] => [
    name,
    value,
  ]);
  return JSON.stringify(pairs);
}

/** Convenience for callers that already hold response-shaped attributes. */
export function signatureFromVariantAttributes(attributes: VariantAttribute[]): string {
  return buildVariantSignature(attributes.map(({ name, value }) => ({ name, value })));
}
