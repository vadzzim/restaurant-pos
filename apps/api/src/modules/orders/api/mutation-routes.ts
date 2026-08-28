import { PAYMENT_METHODS } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../../../shared/errors.js';
import { executeMutation } from './mutation-reply.js';

const identity = {
  mutationId: z.uuid(),
  terminalId: z.string().min(1),
  restaurantId: z.string().min(1),
};

/** Every mutation but creation targets an order that already has a version (§5, §6). */
const existingOrder = { ...identity, baseVersion: z.number().int().min(1) };

/** The four pure transitions take no payload at all; an absent body object is the same as `{}`. */
const noPayload = z.object({}).default({});

const productLine = {
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
};

/**
 * Creation carries `baseVersion: 0` by definition (§5) and every other mutation targets an order
 * that already has a version, so the boundary can reject a nonsensical pair before the handler.
 *
 * One branch per `MutationType`. The discriminated union is what lets `toCommand` in the handler
 * treat the payload as already validated against the type that selected it.
 */
const mutationSchema = z.discriminatedUnion('type', [
  z.object({
    ...identity,
    type: z.literal('CREATE_ORDER'),
    baseVersion: z.literal(0),
    payload: z.object({ tableNumber: z.string().min(1) }),
  }),
  z.object({
    ...existingOrder,
    type: z.literal('ADD_ITEM'),
    payload: z.object(productLine),
  }),
  z.object({
    ...existingOrder,
    type: z.literal('REMOVE_ITEM'),
    payload: z.object({ productId: z.string().min(1) }),
  }),
  z.object({
    ...existingOrder,
    type: z.literal('CHANGE_QUANTITY'),
    // A quantity of zero is not a quantity change, it is a removal, and it has its own mutation
    // type. Accepting it here would give the same intent two spellings and two audit trails.
    payload: z.object(productLine),
  }),
  z.object({
    ...existingOrder,
    type: z.literal('SEND_TO_KITCHEN'),
    payload: noPayload,
  }),
  z.object({
    ...existingOrder,
    type: z.literal('START_PREPARING'),
    payload: noPayload,
  }),
  z.object({
    ...existingOrder,
    type: z.literal('MARK_READY'),
    payload: noPayload,
  }),
  z.object({
    ...existingOrder,
    type: z.literal('PAY'),
    // No amount: the server pays the order's own canonical total (§8, and see M05.md).
    payload: z.object({ method: z.enum(PAYMENT_METHODS) }),
  }),
  z.object({
    ...existingOrder,
    type: z.literal('CANCEL'),
    payload: z.object({ reason: z.string().min(1).max(200).optional() }).default({}),
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
    return executeMutation(db, request, reply, {
      orderId: params.data.orderId,
      mutationId: input.mutationId,
      terminalId: input.terminalId,
      restaurantId: input.restaurantId,
      baseVersion: input.baseVersion,
      type: input.type,
      payload: input.payload,
    });
  });
}
