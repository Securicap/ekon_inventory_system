import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  DEVICE_ID_HEADER,
  REQUEST_ID_HEADER,
  errorCodeSchema,
  type HealthResponse,
} from '@ekon/shared';
import type { Config } from './config/index.js';
import { registerCatalog } from './modules/catalog/index.js';
import { currentSchemaVersion } from './platform/db/migrator.js';
import type { DatabasePool } from './platform/db/pool.js';
import { AppError } from './platform/http/errors.js';
import { newId } from './platform/ids/uuidv7.js';
import type { Clock } from './platform/clock/index.js';

export interface AppDependencies {
  config: Config;
  pool: DatabasePool;
  clock: Clock;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Browser installation id, when the client supplied one. */
    deviceId: string | null;
  }
}

/**
 * Builds the HTTP application without binding a port, so tests can drive it
 * through `app.inject()` and never need a free socket.
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, pool, clock } = deps;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Structured JSON in production; readable in development. Nobody is on
      // site in Haiti, so production logs must be machine-parseable.
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.body.pin'],
        remove: true,
      },
    },
    genReqId: (req) => (req.headers[REQUEST_ID_HEADER] as string | undefined) ?? newId(),
    requestIdHeader: REQUEST_ID_HEADER,
    // Managed hosting terminates TLS in front of the app.
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  app.decorateRequest('deviceId', null);

  app.addHook('onRequest', async (request, reply) => {
    const deviceId = request.headers[DEVICE_ID_HEADER];
    request.deviceId = typeof deviceId === 'string' ? deviceId : null;
    void reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.info({ code: error.code, err: error }, 'handled application error');
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          requestId: request.id,
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: errorCodeSchema.enum.VALIDATION_FAILED,
          message: 'Request validation failed',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          requestId: request.id,
        },
      });
    }

    // Unexpected. Log everything, return nothing but a correlation id.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: errorCodeSchema.enum.INTERNAL,
        message: 'Internal server error',
        requestId: request.id,
      },
    });
  });

  // Whether a frontend build is present is decided once, here, because Fastify
  // permits only one not-found handler per instance.
  const staticDir = path.resolve(process.cwd(), config.STATIC_DIR);
  const serveFrontend = existsSync(staticDir);

  app.setNotFoundHandler((request, reply) => {
    // API routes always answer with structured JSON. Everything else falls
    // through to index.html so client-side routing survives a hard refresh.
    if (!serveFrontend || request.url.startsWith('/api/')) {
      return reply.status(404).send({
        error: {
          code: errorCodeSchema.enum.NOT_FOUND,
          message: `Route ${request.method} ${request.url} not found`,
          requestId: request.id,
        },
      });
    }
    return reply.sendFile('index.html');
  });

  /**
   * Liveness and readiness in one endpoint. Returns 503 when the database is
   * unreachable so the platform stops routing traffic to a broken instance.
   */
  app.get('/api/health', async (_request, reply) => {
    let database: HealthResponse['database'] = 'down';
    let schemaVersion: string | null = null;

    try {
      await pool.query('SELECT 1');
      database = 'up';
      schemaVersion = await currentSchemaVersion(pool);
    } catch {
      database = 'down';
    }

    const body: HealthResponse = {
      status: database === 'up' ? 'ok' : 'degraded',
      version: config.APP_VERSION,
      schemaVersion,
      database,
      time: clock.now().toISOString(),
    };

    return reply.status(database === 'up' ? 200 : 503).send(body);
  });

  // Business modules. Each owns its own tables and routes; the composition root
  // only hands them the shared platform dependencies.
  registerCatalog(app, { pool, clock });

  if (serveFrontend) {
    await registerFrontend(app, staticDir);
  } else {
    app.log.warn(
      { staticDir },
      'Frontend build not found — API only. Run `npm run build --workspace frontend`.',
    );
  }

  return app;
}

/**
 * The backend serves the built frontend from the same origin. One deploy, one
 * certificate, no CORS, and no cookie-domain problems.
 */
async function registerFrontend(app: FastifyInstance, staticDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: staticDir,
    // Content-hashed assets are immutable; index.html must never be cached or
    // a shop laptop will keep running an old build after a deploy.
    setHeaders: (reply, filePath) => {
      if (filePath.endsWith('index.html')) {
        void reply.header('cache-control', 'no-cache');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        void reply.header('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });
}
