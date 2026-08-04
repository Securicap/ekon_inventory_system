import type { FastifyInstance } from 'fastify';
import { receiveStockRequestSchema } from '@ekon/shared';
import { requireActor } from '../identity/index.js';
import type { ReceivingService } from './receivingService.js';
import type { InventoryService } from './service.js';

/**
 * Inventory HTTP surface: reading locations, and booking in stock that arrived.
 *
 * Each route declares the capability it needs, and the identity module's
 * enforcement hook resolves the session and checks that capability before the
 * handler runs. Anyone who reaches a handler here is signed in and permitted;
 * this file contains no authorization check and no notion of a role.
 *
 * Both handlers are deliberately dull. HTTP concerns only: parse the body with
 * the shared schema, take the person from the session, call the application
 * service, choose a status code. The receiving rules — what may be received,
 * what the command hashes to, what movement it becomes — live in the receiving
 * service, and the ledger rules live below that in the posting engine. A
 * handler that called `postMovement` itself would be a third place where "what
 * a receipt is" gets decided.
 */
export function registerInventoryRoutes(
  app: FastifyInstance,
  services: { inventory: InventoryService; receiving: ReceivingService },
): void {
  app.get(
    '/api/inventory/locations',
    { config: { capability: 'inventory.read' } },
    async (_request, reply) => {
      const locations = await services.inventory.listLocations();
      return reply.status(200).send(locations);
    },
  );

  /**
   * Records that stock arrived: one variant, at one location, in one positive
   * quantity, at one business time.
   *
   * `201`, and `201` again on a retry. The command created a movement, and a
   * replay is answered with that same movement rather than a second one;
   * distinguishing the two with different statuses would ask every client to
   * handle a difference that means nothing to the shop — the delivery is booked
   * in, once.
   *
   * The actor comes from `requireActor`, which reads the session the
   * enforcement hook already resolved. It is never taken from the body, and the
   * request schema refuses a body that offers one.
   */
  app.post(
    '/api/inventory/receive',
    { config: { capability: 'inventory.receive' } },
    async (request, reply) => {
      const actor = requireActor(request);
      const input = receiveStockRequestSchema.parse(request.body);
      const result = await services.receiving.receiveStock({ request: input, actorId: actor.id });
      return reply.status(201).send(result);
    },
  );
}
