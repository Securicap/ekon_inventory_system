import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { REQUEST_ID_HEADER, errorCodeSchema, type HealthResponse } from '@ekon/shared';
import type { Config } from './config/index.js';
import { registerCatalog } from './modules/catalog/index.js';
import { registerIdentity } from './modules/identity/index.js';
import { createStockPresenceService, registerInventory } from './modules/inventory/index.js';
import { currentSchemaVersion } from './platform/db/migrator.js';
import type { DatabasePool } from './platform/db/pool.js';
import { AppError, isMalformedJsonBodyError } from './platform/http/errors.js';
import { newId } from './platform/ids/uuidv7.js';
import type { Clock } from './platform/clock/index.js';

/**
 * Paths pino removes before a log line is written.
 *
 * A credential that reaches a log line has been written to disk, shipped to
 * whatever aggregates logs, and kept for as long as that retains anything —
 * which is why `tests/integration/authLogin.test.ts` signs in against a real
 * logger and reads back everything it wrote, rather than trusting this list.
 *
 * `req.headers.cookie` covers the session token on the way in, and is why the
 * authentication routes did not have to add anything for it. There is
 * deliberately no path for the response's `set-cookie`: Fastify's default
 * serializer logs a reply's status code and nothing else, so the token on the
 * way out never reaches the logger at all.
 */
const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
] as const;

export interface AppDependencies {
  config: Config;
  pool: DatabasePool;
  clock: Clock;
  /**
   * Where log lines go. Only tests pass one — to read back what was written and
   * assert that a password was not in it. Production and development leave it
   * unset and log to stdout.
   */
  logDestination?: { write(line: string): void } | undefined;
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
      // A transport and a stream are mutually exclusive, and the pretty
      // transport is a developer convenience — a supplied destination wins.
      ...(config.NODE_ENV === 'development' && !deps.logDestination
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
      ...(deps.logDestination ? { stream: deps.logDestination } : {}),
      // Credentials never reach a log line, not even at trace level.
      redact: { paths: [...LOG_REDACT_PATHS], remove: true },
    },
    genReqId: (req) => (req.headers[REQUEST_ID_HEADER] as string | undefined) ?? newId(),
    requestIdHeader: REQUEST_ID_HEADER,
    // Managed hosting terminates TLS in front of the app.
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  /**
   * Cookie parsing, for the one cookie this application has: the session.
   *
   * Registered here rather than inside the identity module because a plugin
   * decorates the whole instance, and a plugin registered twice is an error. No
   * secret is passed and no cookie is signed — the session cookie carries an
   * opaque random token whose validity is decided by a database lookup, which
   * is a stronger check than a signature and leaves nothing to keep safe.
   *
   * Nothing in this application parses a `Cookie` header by hand.
   */
  await app.register(fastifyCookie);

  // Every response carries its request id, so a failure a user reports can be
  // found in the logs.
  app.addHook('onRequest', async (request, reply) => {
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

    // Fastify rejects a malformed or empty JSON body before the route runs. It
    // is a client mistake, not a server fault, so it gets the same structured
    // 400 shape as validation and is logged at info — never echoing parser
    // internals, a stack trace, or the request body.
    if (isMalformedJsonBodyError(error)) {
      const parserCode = (error as { code?: unknown }).code;
      request.log.info(
        { code: typeof parserCode === 'string' ? parserCode : undefined },
        'malformed request body',
      );
      return reply.status(400).send({
        error: {
          code: errorCodeSchema.enum.VALIDATION_FAILED,
          message: 'Malformed JSON request body',
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
   * Identity, first — before any other API route exists.
   *
   * This call installs the access enforcement that guards the whole
   * application: the startup check that every `/api/` route declares whether it
   * is public, authenticated, or capability-protected, and the request hook
   * that resolves the session cookie and refuses the request when it does not
   * satisfy that declaration. Both are `onRoute`/`onRequest` hooks on this root
   * instance, and a hook only sees routes registered after it — so every route
   * below this line is covered, and moving this call downward would silently
   * unprotect whatever ended up above it.
   *
   * It also registers login, logout, and `/api/auth/me`.
   */
  const identity = registerIdentity(app, { config, pool, clock });

  /**
   * Liveness and readiness in one endpoint. Returns 503 when the database is
   * unreachable so the platform stops routing traffic to a broken instance.
   *
   * Public: a health check that needed a session would be useless to the
   * platform that has to decide whether this instance is taking traffic, and it
   * reveals nothing a caller could not learn by trying to use the application.
   */
  app.get('/api/health', { config: { auth: 'public' } }, async (_request, reply) => {
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
  // only hands them the shared platform dependencies. Their routes declare the
  // capability they require and are enforced by the hook identity installed
  // above — the modules themselves check nothing and know nobody's role.
  //
  // Catalog first: the inventory module asks it whether a variant may be
  // received into, issued from, or corrected, and asks through its application
  // service rather than its tables.
  //
  // The dependency runs the other way too, and this is where the loop is
  // resolved rather than papered over. Archiving merchandise must not be
  // possible while stock remains, and stock is the inventory module's to know —
  // so the catalog declares a narrow `StockPresenceReader` port and is handed
  // inventory's implementation of it here. That implementation depends on
  // nothing (no pool, no clock, no other service), which is precisely why it can
  // be built first and why neither module ends up importing the other's tables.
  const stock = createStockPresenceService();
  const { catalog } = registerCatalog(app, { pool, clock, stock });
  registerInventory(app, { pool, clock, catalog, identity: identity.users });

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
