import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';

declare module 'fastify' {
  interface FastifyRequest {
    /** The §20 correlation id that outlives this request: it is written onto the events. */
    traceId: string;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
const TRACE_ID_HEADER = 'x-trace-id';

/**
 * Ids arrive from the network, so they are bounded and stripped of anything that is not a printable
 * ASCII token. pino escapes its JSON, so this is not about injection; it is about a correlation
 * field staying greppable and a header not being able to grow a log line without limit.
 */
function sanitizeId(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || !/^[\w.:-]+$/.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

/**
 * `requestId` identifies this HTTP call. Fastify v5 disables header-derived ids by default, and
 * reading the header here rather than through `requestIdHeader` keeps both ids going through one
 * sanitizer.
 */
export function generateRequestId(request: IncomingMessage): string {
  return sanitizeId(request.headers[REQUEST_ID_HEADER]) ?? randomUUID();
}

/**
 * `traceId` identifies the *work*, and the work outlives the call: it becomes an outbox row, a
 * Kafka message, a projection write and a broadcast, and both consumers already log it. So a client
 * may supply one and have it followed across all three processes.
 *
 * With no `x-trace-id` the trace **is** the request, and the requestId is reused rather than a
 * second uuid generated — a distinct id there would be a field that correlates with nothing.
 *
 * Both are bound onto the request's own child logger, so the lines Fastify emits for itself carry
 * them too, not only the lines this codebase writes.
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.decorateRequest('traceId', '');

  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.traceId = sanitizeId(request.headers[TRACE_ID_HEADER]) ?? request.id;
    request.log = request.log.child({ requestId: request.id, traceId: request.traceId });
  });
}
