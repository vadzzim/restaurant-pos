import type { OrderSnapshot } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../../../shared/errors.js';
import { loadOrderSnapshot } from '../application/order-snapshot.js';

const paramsSchema = z.object({ orderId: z.uuid() });

/**
 * The canonical snapshot §13 tells the client to refetch on reconnect. It returns the same
 * `OrderSnapshot` the mutation response carries, so the client has one shape to hold.
 */
export function registerOrderReadRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/orders/:orderId', async (request): Promise<OrderSnapshot> => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'orderId must be a UUID.', {
        issues: params.error.issues,
      });
    }

    const snapshot = await loadOrderSnapshot(db, params.data.orderId);
    if (snapshot === undefined) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'No order with that id.', {
        orderId: params.data.orderId,
      });
    }

    return snapshot;
  });
}
