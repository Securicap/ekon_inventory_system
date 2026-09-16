import { catalogMetadataResponseSchema, type CatalogMetadataResponse } from '@ekon/shared';
import { api } from './api.js';

/**
 * What the catalog already knows: its brands, its classification dimensions and
 * their values, and the controlled attribute names.
 *
 * The product form is built from this rather than from anything hard-coded.
 * Attribute names in particular are **structure** — the catalog refuses one it
 * has never heard of — so a form that let somebody type a name would be a form
 * that invites a rejection. It offers what exists instead.
 *
 * One read, one key, and it is a separate key from the product list because the
 * two change for different reasons: creating a product can add a brand or a
 * classification value, and nothing else does.
 */
export const catalogMetadataQueryKey = ['catalog', 'metadata'] as const;

export async function getCatalogMetadata(signal: AbortSignal): Promise<CatalogMetadataResponse> {
  const response = await api.get<unknown>('/api/catalog/metadata', signal);
  return catalogMetadataResponseSchema.parse(response);
}
