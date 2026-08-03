import type { FastifyInstance } from 'fastify';
import type { InventoryService } from './service.js';

/**
 * Inventory HTTP surface. Read-only for now: it lists locations.
 *
 * Authorization gap (intentional, documented): capability enforcement is not
 * wired yet because no authenticated principal exists — the identity module is
 * still a scaffold. The route declares the capability it will require in its
 * `config` (`inventory.read`), so a single `onRequest` hook can enforce it once
 * identity lands, without touching this handler. Same convention as catalog.
 * See backend/src/modules/inventory/README.md.
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
