import { KITCHEN_TERMINAL_ID, type MutationType } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { executeMutation } from '../../orders/api/mutation-reply.js';
import { validationFailed } from '../../../shared/errors.js';

const paramsSchema = z.object({ orderId: z.uuid() });

/**
 * The same identity every mutation carries (§5). `terminalId` defaults because a kitchen display
 * is not one of the seeded tills; it is still sent when a specific display wants to own its
 * entries in `conflict_log`.
 */
const bodySchema = z.object({
  mutationId: z.uuid(),
  restaurantId: z.string().min(1),
  baseVersion: z.number().int().min(1),
  terminalId: z.string().min(1).default(KITCHEN_TERMINAL_ID),
});

/**
 * The two kitchen endpoints of §17. They are **thin adapters**: they read better as domain
 * commands than `POST /mutations` with a type in the body, and that is the whole of their value.
 * They construct a mutation and hand it to the same handler, so a kitchen transition is subject to
 * the same tenant check, the same idempotency and the same versioned UPDATE as anything a POS
 * sends. Two displays pressing Ready at the same `baseVersion` produce one success and one
 * conflict (§21.10) precisely because nothing here short-circuits that path.
 *
 * No rule lives in this file. If one ever appears here it belongs in `decide()`.
 */
export function registerKitchenCommandRoutes(app: FastifyInstance, db: Db): void {
  register(app, db, 'preparing', 'START_PREPARING');
  register(app, db, 'ready', 'MARK_READY');
}

function register(app: FastifyInstance, db: Db, segment: string, type: MutationType): void {
  app.post(`/api/kitchen/orders/:orderId/${segment}`, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      throw validationFailed('orderId must be a UUID.', params.error);
    }

    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      throw validationFailed('The kitchen command body is not valid.', body.error);
    }

    return executeMutation(db, request, reply, {
      orderId: params.data.orderId,
      mutationId: body.data.mutationId,
      terminalId: body.data.terminalId,
      restaurantId: body.data.restaurantId,
      baseVersion: body.data.baseVersion,
      type,
      payload: {},
    });
  });
}
