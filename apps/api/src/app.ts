import type { ApiErrorResponse } from '@pos/contracts';
import type { Db } from '@pos/db';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerConfigRoutes } from './modules/config/api/config-routes.js';
import { registerHealthRoutes } from './modules/health/api/health-routes.js';
import type { DependencyProbe } from './modules/health/application/dependency-probes.js';
import { registerKitchenCommandRoutes } from './modules/kitchen/api/kitchen-command-routes.js';
import { registerKitchenReadRoutes } from './modules/kitchen/api/kitchen-read-routes.js';
import { registerMenuRoutes } from './modules/menu/api/menu-routes.js';
import { registerMutationRoutes } from './modules/orders/api/mutation-routes.js';
import { registerOrderReadRoutes } from './modules/orders/api/order-read-routes.js';
import { ApiError, asClientError } from './shared/errors.js';
import {
  correlatedChildLogger,
  generateRequestId,
  registerRequestContext,
} from './shared/request-context.js';

export interface BuildAppOptions {
  db: Db;
  logLevel?: string;
  /**
   * Where the logs go. Process stdout by default; a test passes a collector, which is the only way
   * to assert on the lines Fastify writes for itself — `incoming request` above all, since that is
   * the one the correlation fields are easiest to miss on.
   */
  logDestination?: { write: (line: string) => void } | undefined;
  /** The complete dependency list for the health routes; see `HealthRouteOptions`. */
  probes?: DependencyProbe[];
  healthTimeoutMs?: number;
}

/**
 * Routes and the error handler, and nothing else. Socket.IO and the realtime consumer are wired in
 * `index.ts` instead, so `fastify.inject` tests need neither a broker nor Redis.
 */
export function buildApp({
  db,
  logLevel = 'info',
  logDestination,
  probes,
  healthTimeoutMs,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: logLevel,
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
    genReqId: generateRequestId,
    // Binds `requestId` and `traceId` before Fastify logs `incoming request`, so the first line of
    // a request carries them too. A hook cannot: it runs after that line is written.
    childLoggerFactory: correlatedChildLogger,
  });

  registerRequestContext(app);

  /**
   * The one place a failure becomes a response. Three kinds arrive here and each has one answer:
   *
   * - `ApiError` — raised deliberately by a boundary. Logged at `warn`: it is the client's fault.
   * - A Fastify 4xx — a body that is not JSON, a payload over the limit. These carry their own
   *   status code and must keep it; answering 500 would tell a client its malformed request was a
   *   server fault, and under §14 that is the difference between fixing the payload and retrying
   *   it forever.
   * - Anything else — a real fault. It is logged with its stack and answered anonymously (§17).
   *
   * A §5 domain outcome never reaches this handler: a conflict is a *successful* application of
   * the rules and returns a snapshot through `executeMutation`.
   */
  app.setErrorHandler((error, request, reply) => {
    const clientError = error instanceof ApiError ? error : asClientError(error);

    if (clientError !== undefined) {
      request.log.warn(
        { code: clientError.code, httpStatus: clientError.httpStatus },
        clientError.message,
      );
      return reply.status(clientError.httpStatus).send(clientError.toResponse());
    }

    // No stack traces in responses (§17); the log keeps them.
    request.log.error({ err: error }, 'Unhandled error');
    const body: ApiErrorResponse = {
      code: 'INTERNAL_ERROR',
      message: 'The request could not be processed.',
    };
    return reply.status(500).send(body);
  });

  /** Fastify's own 404 body is not the §17 envelope, and nothing may leave the API in a fourth shape. */
  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorResponse = {
      code: 'ROUTE_NOT_FOUND',
      message: 'No such route.',
      details: { method: request.method, url: request.url },
    };
    return reply.status(404).send(body);
  });

  registerHealthRoutes(app, { db, probes, timeoutMs: healthTimeoutMs });
  registerConfigRoutes(app, db);
  registerMenuRoutes(app, db);
  registerOrderReadRoutes(app, db);
  registerKitchenReadRoutes(app, db);
  registerMutationRoutes(app, db);
  registerKitchenCommandRoutes(app, db);

  return app;
}
