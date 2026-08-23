import type { FastifyInstance } from 'fastify';
import {
  createProductRequestSchema,
  productLifecycleParamsSchema,
  updateLifecycleRequestSchema,
  variantLifecycleParamsSchema,
} from '@ekon/shared';
import type { LifecycleService } from './lifecycleService.js';
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
export function registerCatalogRoutes(
  app: FastifyInstance,
  services: { catalog: CatalogService; lifecycle: LifecycleService },
): void {
  const service = services.catalog;

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

  /**
   * Withdraws merchandise, or brings it back: `ACTIVE`, `DISCONTINUED`, or
   * `ARCHIVED`, stated declaratively.
   *
   * **`catalog.deactivate`, not `catalog.write`.** The narrower capability
   * already exists for exactly this — deciding what the business stops selling
   * is a different authority from entering what it sells, and somebody trusted
   * to type in a new sandal is not thereby trusted to withdraw the range. A
   * route that reached for `catalog.write` would silently merge the two.
   *
   * `PATCH` rather than `POST`, and a status rather than a verb: the body says
   * what the merchandise should be, so sending it twice changes nothing the
   * second time and two people pressing the same button agree. A
   * `POST /discontinue` would spread the transition matrix across the URL
   * space.
   *
   * `200`, because this modifies an existing resource and answers with it. A
   * refused transition and an archive blocked by remaining stock are both
   * `409` — the request was well formed, and the merchandise's own state is
   * what conflicts with it.
   *
   * The id is in the path and refused in the body. Two statements of one
   * identity can disagree, and the one that would win is the one nobody reads.
   */
  app.patch(
    '/api/catalog/products/:productId/lifecycle',
    { config: { capability: 'catalog.deactivate' } },
    async (request, reply) => {
      const { productId } = productLifecycleParamsSchema.parse(request.params);
      const input = updateLifecycleRequestSchema.parse(request.body);
      const product = await services.lifecycle.setProductLifecycle(
        productId,
        input.lifecycleStatus,
      );
      return reply.status(200).send(product);
    },
  );

  /**
   * The same, for one SKU.
   *
   * A separate route rather than a field, because they are separate decisions
   * about separate things: withdrawing one colour is not withdrawing the model,
   * and a single endpoint taking "productId or variantId" would make the
   * difference a shape in a body. Withdrawing the product already governs every
   * variant beneath it — the effective status is the stricter of the two — so
   * nothing here needs to cascade, and nothing does.
   */
  app.patch(
    '/api/catalog/variants/:variantId/lifecycle',
    { config: { capability: 'catalog.deactivate' } },
    async (request, reply) => {
      const { variantId } = variantLifecycleParamsSchema.parse(request.params);
      const input = updateLifecycleRequestSchema.parse(request.body);
      const variant = await services.lifecycle.setVariantLifecycle(
        variantId,
        input.lifecycleStatus,
      );
      return reply.status(200).send(variant);
    },
  );
}
