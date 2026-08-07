import type { FastifyInstance } from 'fastify';
import { receiveStockRequestSchema, removeStockRequestSchema } from '@ekon/shared';
import { requireActor } from '../identity/index.js';
import type { ReceivingService } from './receivingService.js';
import type { RemovalService } from './removalService.js';
import type { InventoryService } from './service.js';

/**
 * Inventory HTTP surface: reading locations, reading current stock, booking in
 * stock that arrived, and recording stock that left.
 *
 * Each route declares the capability it needs, and the identity module's
 * enforcement hook resolves the session and checks that capability before the
 * handler runs. Anyone who reaches a handler here is signed in and permitted;
 * this file contains no authorization check and no notion of a role.
 *
 * Every handler is deliberately dull. HTTP concerns only: parse the body with
 * the shared schema, take the person from the session, call the application
 * service, choose a status code. The workflow rules — what may be received or
 * removed, what the command hashes to, what movement it becomes — live in the
 * receiving and removal services, and the ledger rules live below those in the
 * posting engine. A handler that called `postMovement` itself would be a third
 * place where "what a receipt is" gets decided.
 *
 * Receiving and removal are **separate endpoints under separate capabilities**,
 * not one movement endpoint with a direction. Booking in a delivery and taking
 * a bottle off the shelf are different business acts that different people are
 * trusted with, and a generic `/api/inventory/movements` would make the
 * difference a field in a body rather than a door somebody was given a key to.
 */
export function registerInventoryRoutes(
  app: FastifyInstance,
  services: { inventory: InventoryService; receiving: ReceivingService; removal: RemovalService },
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
   * What the business currently holds: every active variant, and its quantity at
   * every active location.
   *
   * An ordinary read of the balance projection. No query parameters in this
   * version — no page, filter, sort, or search — so there is nothing to parse
   * and nothing to validate; the handler asks the service and sends what it
   * gets. An empty catalog answers `200` with `[]`, because "we stock nothing"
   * is an answer rather than a missing resource.
   *
   * Nothing here writes, and the service it calls holds no transaction, takes no
   * lock, and creates no balance rows.
   */
  app.get(
    '/api/inventory/balances',
    { config: { capability: 'inventory.read' } },
    async (_request, reply) => {
      const balances = await services.inventory.listStockBalances();
      return reply.status(200).send(balances);
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

  /**
   * Records that stock left: one variant, from one location, in one positive
   * quantity, for one reason, at one business time.
   *
   * Requires **`inventory.remove`**, which is not `inventory.adjust`. Recording
   * that stock left is what somebody at the counter does all day; correcting a
   * balance that was wrong is authority over the records themselves, and gating
   * the first behind the second would have handed every employee the second in
   * order to permit the first.
   *
   * `201`, and `201` again on a retry — the same rule receiving follows, and
   * the same reason: the command created a movement, and a replay is answered
   * with that same movement rather than a second one. Distinguishing the two
   * with different statuses would ask every client to handle a difference that
   * means nothing to the shop.
   *
   * A shortfall comes back as `INSUFFICIENT_STOCK` from the posting engine,
   * which maps to `422`: the request was well formed and the shelf could not
   * satisfy it. Nothing partial is removed and nothing is clamped.
   */
  app.post(
    '/api/inventory/remove',
    { config: { capability: 'inventory.remove' } },
    async (request, reply) => {
      const actor = requireActor(request);
      const input = removeStockRequestSchema.parse(request.body);
      const result = await services.removal.removeStock({ request: input, actorId: actor.id });
      return reply.status(201).send(result);
    },
  );
}
