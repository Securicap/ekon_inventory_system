import type { FastifyInstance } from 'fastify';
import type { SystemStatusResponse } from '@ekon/shared';
import type { SystemStatusService } from './statusService.js';

/**
 * The system module's HTTP surface: one read, and deliberately no writes.
 *
 * There is no endpoint here that takes a backup, runs a restore, applies a
 * migration, or restarts anything, and that is a decision rather than an
 * omission. Those are `ekon-ctl`, run by somebody with the machine in front of
 * them, because each of them can destroy the business's records and none of
 * them should be one mis-click away on a screen that an owner opens while
 * worried. This endpoint reports; the command line acts.
 */
export function registerSystemRoutes(app: FastifyInstance, status: SystemStatusService): void {
  /**
   * How the installation is doing — build, schema, profile, last backup, free
   * space.
   *
   * `system.manage`, which migration 0015 grants to `OWNER` and `SUPER_ADMIN`
   * only. Not `audit.read` and not `inventory.read`: this describes the machine
   * rather than what anybody did on it, and "when was the last backup" is also
   * the answer to "how much would be lost", which is not a fact for a counter
   * screen.
   */
  app.get(
    '/api/system/status',
    { config: { capability: 'system.manage' } },
    async (_req, reply) => {
      const body: SystemStatusResponse = await status.read();
      return reply.status(200).send(body);
    },
  );
}
