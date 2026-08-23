import type { FastifyInstance } from 'fastify';
import { createProductRequestSchema } from '@ekon/shared';
import type { CatalogService } from './service.js';

/**
 * Catalog HTTP surface.
 *
 * Requests are parsed with the shared Zod schemas; a parse failure throws a
 * ZodError that the application's central error handler turns into a structured
 * `VALIDATION_FAILED` 400. Success bodies are the shared response shapes.
 *
 * Both routes are capability-protected. Each declares what it requires in its
 * `config`, and the identity module's enforcement hook resolves the session and
 * checks the capability before either handler runs — so a caller who reaches
 * one of these has a valid session and holds the capability, and neither
 * handler contains an authorization check or knows anybody's role.
 *
 * Neither reads the actor: creating a product records no `user_id` yet. The
 * workflows that do — receiving, adjustments, counts — will take it from
 * `requireActor(request)`, never from the request body.
 */
export function registerCatalogRoutes(app: FastifyInstance, service: CatalogService): void {
  app.post(
    '/api/catalog/products',
    { config: { capability: 'catalog.write' } },
    async (request, reply) => {
      const input = createProductRequestSchema.parse(request.body);
      const product = await service.createProduct(input);
      return reply.status(201).send(product);
    },
  );

  app.get(
    '/api/catalog/products',
    { config: { capability: 'catalog.read' } },
    async (_request, reply) => {
      const products = await service.listProducts();
      return reply.status(200).send(products);
    },
  );

  /**
   * What the catalog already knows — its brands, its classification dimensions
   * and their values, and the controlled attribute names.
   *
   * One bounded read rather than an endpoint per vocabulary. These are three
   * small lists wanted together by the one form that needs them, and splitting
   * them would be three round trips to fill in one screen. It is read-only on
   * purpose: brands and classification values are created as a side effect of
   * entering merchandise, and attribute names are structure that grows by
   * migration until there is a workflow to grow it — so there is nothing here
   * for a management endpoint to manage yet.
   */
  app.get(
    '/api/catalog/metadata',
    { config: { capability: 'catalog.read' } },
    async (_request, reply) => {
      const metadata = await service.getMetadata();
      return reply.status(200).send(metadata);
    },
  );
}
