import type { FastifyInstance } from 'fastify';
import type { InventoryService } from './service.js';

/**
 * Inventory HTTP surface. Read-only for now: it lists locations.
 *
 * The route declares `inventory.read`, and the identity module's enforcement
 * hook resolves the session and checks that capability before the handler runs.
 * Anyone who reaches it is signed in and may read stock; this file contains no
 * authorization check and no notion of a role.
 *
 * Posting a movement will need the actor — it becomes the `user_id` on the
 * ledger row — and will take it from `requireActor(request)`. Nothing about the
 * person is ever read from the request body.
 */
export function registerInventoryRoutes(app: FastifyInstance, service: InventoryService): void {
  app.get(
    '/api/inventory/locations',
    { config: { capability: 'inventory.read' } },
    async (_request, reply) => {
      const locations = await service.listLocations();
      return reply.status(200).send(locations);
    },
  );
}
