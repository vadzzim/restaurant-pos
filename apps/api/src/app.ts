import type { Db } from '@pos/db';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerMutationRoutes } from './modules/orders/api/mutation-routes.js';
import { ApiError } from './shared/errors.js';

export interface BuildAppOptions {
  db: Db;
  logLevel?: string;
}

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

  registerMutationRoutes(app, db);

  return app;
}
