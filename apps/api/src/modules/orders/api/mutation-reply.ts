import type { Db } from '@pos/db';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { applyMutation, type MutationInput } from '../application/mutation-handler.js';

/**
 * The one place a mutation outcome becomes an HTTP reply. Three routes construct mutations — the
 * canonical `POST /api/orders/:orderId/mutations` and the two kitchen adapters of §17 — and they
 * must be indistinguishable to a client: the same status codes, the same §5 bodies, the same
 * correlation fields in the log. Duplicating twelve lines three times is how they drift apart.
 *
 * The adapters therefore carry no rule of their own. They read as domain commands and they
 * validate their own body; everything after that is this function and the handler behind it.
 */
export async function executeMutation(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  input: Omit<MutationInput, 'traceId'>,
): Promise<FastifyReply> {
  const outcome = await applyMutation(db, { ...input, traceId: request.id });

  request.log.info(
    {
      traceId: request.id,
      orderId: input.orderId,
      mutationId: input.mutationId,
      restaurantId: input.restaurantId,
      terminalId: input.terminalId,
      mutationType: input.type,
      outcome: outcome.body.status,
    },
    'mutation processed',
  );

  return reply.status(outcome.httpStatus).send(outcome.body);
}
