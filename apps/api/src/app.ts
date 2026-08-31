import type { ApiErrorResponse } from '@pos/contracts';
import type { Db } from '@pos/db';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerConfigRoutes } from './modules/config/api/config-routes.js';
import { registerFlagRoutes } from './modules/config/api/flag-routes.js';
import type { FlagCache } from './modules/config/application/resolve-flags.js';
import { registerDebugRoutes } from './modules/debug/api/debug-routes.js';
import { registerSimulatorRoutes } from './modules/debug/api/simulator-routes.js';
import type { ConsumerLagProbe } from './modules/debug/application/consumer-lag.js';
import { incrementCounter } from './modules/debug/application/counters.js';
import type {
  PresenceStore,
  SharedCounterStore,
  SocketGauge,
} from './modules/debug/application/ports.js';
import { registerHealthRoutes } from './modules/health/api/health-routes.js';
import type { DependencyProbe } from './modules/health/application/dependency-probes.js';
import { registerKitchenCommandRoutes } from './modules/kitchen/api/kitchen-command-routes.js';
import { registerKitchenReadRoutes } from './modules/kitchen/api/kitchen-read-routes.js';
import { registerMenuRoutes } from './modules/menu/api/menu-routes.js';
import { registerConflictRoutes } from './modules/orders/api/conflict-routes.js';
import { registerMutationRoutes } from './modules/orders/api/mutation-routes.js';
import { registerOrderReadRoutes } from './modules/orders/api/order-read-routes.js';
import { registerPrinterRoutes } from './modules/printer/api/printer-routes.js';
import { registerPresenceRoutes } from './modules/realtime/api/presence-routes.js';
import { createFakePrinter, type FakePrinter } from './modules/printer/application/fake-printer.js';
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
  /**
   * The fake device behind `POST /api/printer/print`. A fresh one per app by default; a test passes
   * its own so it can read `physicalPrints()`, which is the assertion §21.14 actually rests on.
   */
  printer?: FakePrinter;
  /**
   * §20's `/debug` surface. Every one of these is optional and injected, for the reason ADR 006
   * gives: `buildApp()` must build against PostgreSQL alone, so `fastify.inject` tests need
   * neither Redis nor a broker. When one is absent the endpoint says so — presence comes back
   * empty with a reason, lag comes back `null` — rather than pretending a zero.
   */
  socketGauge?: SocketGauge | undefined;
  presence?: PresenceStore | undefined;
  sharedCounters?: SharedCounterStore | undefined;
  consumerLag?: ConsumerLagProbe | undefined;
  debugRowLimit?: number;
  /**
   * The publisher's lease, which is the only thing that bounds a usable `Delay Outbox Publishing`
   * (§18). The API never publishes; it needs this number solely to refuse a delay the worker could
   * not honour. Defaulted to `OUTBOX_LEASE_MS`'s own default so a test app needs no config.
   */
  outboxLeaseMs?: number;
  /**
   * §15's cache in front of `feature_flags`. Absent means every `/api/config` reads the table,
   * which is what the tests do and what a single-instance run can afford.
   */
  flagCache?: FlagCache | undefined;
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
  printer = createFakePrinter(),
  socketGauge,
  presence,
  sharedCounters,
  consumerLag,
  debugRowLimit = 50,
  outboxLeaseMs = 30_000,
  flagCache,
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
   * §20's `apiRequests` / `apiErrors`, at the one place every response passes through.
   *
   * `onResponse` rather than a per-route wrapper: it counts the 404s and the malformed bodies too,
   * which are exactly the requests a route handler never sees. The split is by status code and not
   * by whether the error handler ran, because a 503 from readiness is an error to whoever is
   * reading this page whether or not it was thrown.
   */
  app.addHook('onResponse', async (_request, reply) => {
    incrementCounter('apiRequests');
    if (reply.statusCode >= 400) {
      incrementCounter('apiErrors');
    }
  });

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

  registerHealthRoutes(app, { db, probes, timeoutMs: healthTimeoutMs, consumerLag });
  registerConfigRoutes(app, { db, cache: flagCache });
  registerMenuRoutes(app, db);
  registerOrderReadRoutes(app, db);
  registerKitchenReadRoutes(app, db);
  registerMutationRoutes(app, db);
  registerConflictRoutes(app, db);
  registerKitchenCommandRoutes(app, db);
  registerPrinterRoutes(app, db, printer);
  registerPresenceRoutes(app, { presence });
  registerDebugRoutes(app, {
    db,
    rowLimit: debugRowLimit,
    socketGauge,
    presence,
    sharedCounters,
  });
  registerSimulatorRoutes(app, { db, outboxLeaseMs });
  registerFlagRoutes(app, { db, cache: flagCache });

  return app;
}
