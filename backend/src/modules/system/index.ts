import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config/index.js';
import type { DatabasePool } from '../../platform/db/pool.js';
import { registerSystemRoutes } from './routes.js';
import { createSystemStatusService, type SystemStatusService } from './statusService.js';

/**
 * The `system` module's composition entry point.
 *
 * **Owns no table.** It is the one module that describes the installation
 * rather than the business, and every fact it reports is read from somewhere
 * that already holds it: the configuration, `schema_migrations`, the backup
 * state file, the filesystem. There is nothing here to migrate and nothing to
 * keep consistent.
 *
 * It also owns no *writes*. Backing up, restoring, and migrating are
 * `ekon-ctl`, on the machine, by somebody who meant it.
 */
export function registerSystem(
  app: FastifyInstance,
  deps: { config: Config; pool: DatabasePool },
): { status: SystemStatusService } {
  const status = createSystemStatusService(deps);
  registerSystemRoutes(app, status);
  return { status };
}

export { createSystemStatusService } from './statusService.js';
export type { SystemStatusService, SystemStatusServiceDeps } from './statusService.js';
