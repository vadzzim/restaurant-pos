import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../../../shared/errors.js';
import { applyMutation } from '../application/mutation-handler.js';

const identity = {
  mutationId: z.uuid(),
  terminalId: z.string().min(1),
  restaurantId: z.string().min(1),
};

/**
 * Creation carries `baseVersion: 0` by definition (§5) and every other mutation targets an order
 * that already has a version, so the boundary can reject a nonsensical pair before the handler.
 */
const mutationSchema = z.discriminatedUnion('type', [
  z.object({
    ...identity,
    type: z.literal('CREATE_ORDER'),
    baseVersion: z.literal(0),
    payload: z.object({ tableNumber: z.string().min(1) }),
  }),
  z.object({
    ...identity,
    type: z.literal('ADD_ITEM'),
    baseVersion: z.number().int().min(1),
    payload: z.object({
      productId: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
  }),
  z.object({
    ...identity,
    type: z.literal('SEND_TO_KITCHEN'),
    baseVersion: z.number().int().min(1),
    payload: z.object({}).default({}),
  }),
]);

const paramsSchema = z.object({ orderId: z.uuid() });

/**
 * The only write endpoint in the system (§17). There is deliberately no POST /api/orders: a
 * separate creation route would be the one write not covered by idempotency and tenant scoping.
 */
export function registerMutationRoutes(app: FastifyInstance, db: Db): void {
  app.post('/api/orders/:orderId/mutations', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'orderId must be a UUID.', {
        issues: params.error.issues,
      });
    }

    const body = mutationSchema.safeParse(request.body);
    if (!body.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The mutation body is not valid.', {
        issues: body.error.issues,
      });
    }

    const input = body.data;
    const outcome = await applyMutation(db, {
      orderId: params.data.orderId,
      mutationId: input.mutationId,
      terminalId: input.terminalId,
      restaurantId: input.restaurantId,
      baseVersion: input.baseVersion,
      type: input.type,
      payload: input.payload,
      traceId: request.id,
    });

    request.log.info(
      {
        traceId: request.id,
        orderId: params.data.orderId,
        mutationId: input.mutationId,
        restaurantId: input.restaurantId,
        terminalId: input.terminalId,
        mutationType: input.type,
        outcome: outcome.body.status,
      },
      'mutation processed',
    );

    return reply.status(outcome.httpStatus).send(outcome.body);
  });
}
