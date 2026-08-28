import type { Db } from '@pos/db';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerConfigRoutes } from './modules/config/api/config-routes.js';
import { registerKitchenCommandRoutes } from './modules/kitchen/api/kitchen-command-routes.js';
import { registerKitchenReadRoutes } from './modules/kitchen/api/kitchen-read-routes.js';
import { registerMenuRoutes } from './modules/menu/api/menu-routes.js';
import { registerMutationRoutes } from './modules/orders/api/mutation-routes.js';
import { registerOrderReadRoutes } from './modules/orders/api/order-read-routes.js';
import { ApiError } from './shared/errors.js';

export interface BuildAppOptions {
  db: Db;
  logLevel?: string;
}

/**
 * Routes and the error handler, and nothing else. Socket.IO and the realtime consumer are wired in
 * `index.ts` instead, so `fastify.inject` tests need neither a broker nor Redis.
 */
export function buildApp({ db, logLevel = 'info' }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: { level: logLevel } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      request.log.warn({ code: error.code, traceId: request.id }, error.message);
      return reply.status(error.httpStatus).send(error.toResponse());
    }

    // No stack traces in responses (§17); the log keeps them.
    request.log.error({ err: error, traceId: request.id }, 'Unhandled error');
    return reply
      .status(500)
      .send({ code: 'INTERNAL_ERROR', message: 'The request could not be processed.' });
  });

  app.get('/api/health/live', async () => ({ status: 'ok' }));
  app.get('/api/health/ready', async () => ({ status: 'ok' }));

  registerConfigRoutes(app, db);
  registerMenuRoutes(app, db);
  registerOrderReadRoutes(app, db);
  registerKitchenReadRoutes(app, db);
  registerMutationRoutes(app, db);
  registerKitchenCommandRoutes(app, db);

  return app;
}
