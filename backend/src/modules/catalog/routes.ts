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
 * Authorization gap (intentional, documented): capability enforcement is not
 * wired yet because no authenticated principal exists — the identity module is
 * still a scaffold. Each route declares the capability it will require in its
 * `config`, so a single `onRequest` hook can enforce them once identity lands,
 * without touching these handlers. Until then these endpoints are unauthenticated.
 * See backend/src/modules/catalog/README.md.
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
}
