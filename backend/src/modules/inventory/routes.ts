import type { FastifyInstance } from 'fastify';
import {
  adjustStockRequestSchema,
  movementHistoryQuerySchema,
  receiveStockRequestSchema,
  removeStockRequestSchema,
  reverseMovementRequestSchema,
} from '@ekon/shared';
import { requireActor } from '../identity/index.js';
import type { AdjustmentService } from './adjustmentService.js';
import type { MovementHistoryService } from './movementHistoryService.js';
import type { ReceivingService } from './receivingService.js';
import type { RemovalService } from './removalService.js';
import type { ReversalService } from './reversalService.js';
import type { InventoryService } from './service.js';

/**
 * Inventory HTTP surface: reading locations, reading current stock, booking in
 * stock that arrived, recording stock that left, correcting a quantity that was
 * wrong, and reversing a movement that should never have been posted.
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
 * Receiving, removal, adjustment, and reversal are **four endpoints under four
 * capabilities**, not one movement endpoint with a direction and a type. Booking in a delivery and taking
 * a bottle off the shelf are different business acts that different people are
 * trusted with, and a generic `POST /api/inventory/movements` would make the
 * difference a field in a body rather than a door somebody was given a key to.
 * That objection is about *writing*: `GET /api/inventory/movements` reads the
 * one ledger all four of those workflows append to, and reading it is a single
 * act under a single capability.
 *
 * The four write endpoints are not variations of each other. Booking in a
 * delivery, taking a bottle off the shelf, saying the recorded number was
 * wrong, and undoing a movement that should never have been posted are
 * different business acts that different people are trusted with, and a generic
 * `POST /api/inventory/movements` would make the difference a field in a body
 * rather than a door somebody was given a key to.
 */
export function registerInventoryRoutes(
  app: FastifyInstance,
  services: {
    inventory: InventoryService;
    history: MovementHistoryService;
    receiving: ReceivingService;
    removal: RemovalService;
    adjustment: AdjustmentService;
    reversal: ReversalService;
  },
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

  /**
   * Records that a quantity was **wrong**: one variant, at one location, by one
   * signed correction, for one reason, at one business time.
   *
   * Requires **`inventory.adjust`**, which is not `inventory.remove` and is
   * deliberately withheld from employees by the default seed. Recording that
   * stock left says what happened; adjusting says the record was wrong, and the
   * second can make a shortfall disappear — so it is the one that has to be
   * given on purpose. The two capabilities are never merged, and neither route
   * accepts the other's.
   *
   * The body carries a **signed** `quantityDelta` and no movement type. The
   * server derives `ADJUSTMENT_IN` or `ADJUSTMENT_OUT` from the sign, so the
   * two can never disagree.
   *
   * `201`, and `201` again on a retry — the same rule receiving and removal
   * follow. A shortfall comes back as `INSUFFICIENT_STOCK` (`422`) from the
   * posting engine: an adjustment can no more take stock below zero than
   * anything else can, and nothing is clamped.
   */
  app.post(
    '/api/inventory/adjust',
    { config: { capability: 'inventory.adjust' } },
    async (request, reply) => {
      const actor = requireActor(request);
      const input = adjustStockRequestSchema.parse(request.body);
      const result = await services.adjustment.adjustStock({ request: input, actorId: actor.id });
      return reply.status(201).send(result);
    },
  );

  /**
   * Undoes one movement by appending its compensation: `POST` a movement id,
   * get a `REVERSAL` of it.
   *
   * Requires **`inventory.reverse`**, and is deliberately not authorized
   * through `inventory.adjust`. They are separate capabilities because they are
   * separate powers: an adjustment states a new number, a reversal reaches back
   * into settled history and takes one of its movements back out of the
   * balance. A shop may well want the first without the second.
   *
   * The body names the movement and nothing else about the stock. The variant,
   * the location, the quantity, and the direction are read from the original
   * row inside the transaction, so there is nothing here for a caller to state
   * wrongly.
   *
   * `201`: the command created a movement — a new one, beside the original,
   * which is untouched. A retry is answered with that same reversal rather than
   * a second one. `404` for a movement that does not exist, `409` for a
   * movement that is itself a reversal or has already been reversed, and `422`
   * (`INSUFFICIENT_STOCK`) when reversing would take the shelf below zero.
   */
  app.post(
    '/api/inventory/reverse',
    { config: { capability: 'inventory.reverse' } },
    async (request, reply) => {
      const actor = requireActor(request);
      const input = reverseMovementRequestSchema.parse(request.body);
      const result = await services.reversal.reverseMovement({
        request: input,
        actorId: actor.id,
      });
      return reply.status(201).send(result);
    },
  );

  /**
   * What happened, and what it did to the shelf: the append-only ledger, read.
   *
   * `inventory.read`, the same capability that answers what is on the shelf
   * today. History is inventory visibility — somebody who may see the numbers
   * may see how they got there, and inventing a capability for it would mean
   * granting one to everybody who already has the other.
   *
   * The query is parsed with the shared schema exactly as a body is, because a
   * query string is request input like any other and an unparsed one is an
   * unvalidated one. It is `.strict()`, so a mistyped parameter is refused
   * rather than dropped — a request filtered by `varientId` would otherwise be
   * answered with the whole ledger and look like it had worked.
   *
   * A `GET` and nothing but: no transaction, no lock, no clock, no balance row
   * brought into existence to answer a read. An explicit test asserts that
   * calling this changes neither a movement nor a balance.
   */
  app.get(
    '/api/inventory/movements',
    { config: { capability: 'inventory.read' } },
    async (request, reply) => {
      const query = movementHistoryQuerySchema.parse(request.query);
      const page = await services.history.listMovements(query);
      return reply.status(200).send(page);
    },
  );
}
