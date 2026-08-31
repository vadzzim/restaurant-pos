import { CONFLICT_RESOLUTIONS, type ConflictResolutionResponse } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { validationFailed } from '../../../shared/errors.js';
import { recordConflictResolution } from '../application/record-conflict-resolution.js';

const paramsSchema = z.object({ orderId: z.uuid() });

const bodySchema = z.object({
  terminalId: z.string().min(1),
  resolution: z.enum(CONFLICT_RESOLUTIONS),
  // Bounded because it becomes an `in (...)` list: a client's queue for one order is a handful of
  // mutations, and an unbounded list here is an unbounded statement.
  mutationIds: z.array(z.uuid()).min(1).max(100),
});

/**
 * §14.1's other half, reported back: how the client unblocked itself. See
 * `record-conflict-resolution.ts` for why this exists and why it is scoped to an order and a
 * terminal rather than to a mutation.
 */
export function registerConflictRoutes(app: FastifyInstance, db: Db): void {
  app.post('/api/orders/:orderId/conflicts/resolution', async (request) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      throw validationFailed('orderId must be a UUID.', params.error);
    }

    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      throw validationFailed('The resolution body is not valid.', body.error);
    }

    const resolved = await recordConflictResolution(db, {
      orderId: params.data.orderId,
      terminalId: body.data.terminalId,
      resolution: body.data.resolution,
      mutationIds: body.data.mutationIds,
    });

    request.log.info(
      { orderId: params.data.orderId, terminalId: body.data.terminalId, resolved },
      'conflict resolution recorded',
    );

    return { resolved } satisfies ConflictResolutionResponse;
  });
}
