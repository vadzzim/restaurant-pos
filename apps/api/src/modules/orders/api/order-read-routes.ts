import type { OrderSnapshot } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError, validationFailed } from '../../../shared/errors.js';
import { loadOrderSnapshot } from '../application/order-snapshot.js';

const paramsSchema = z.object({ orderId: z.uuid() });

/**
 * The canonical snapshot §13 tells the client to refetch on reconnect. It returns the same
 * `OrderSnapshot` the mutation response carries, so the client has one shape to hold.
 *
 * `loadOrderSnapshot` reads `orders` and `order_items` in two statements. The mutation handler
 * calls it inside the transaction that just wrote both, so it is consistent there — but a bare
 * read is not: under PostgreSQL's default READ COMMITTED every statement takes a *fresh* snapshot,
 * so a mutation committing between the two would return the old header with the new items, and the
 * client would show a total that matches neither version. Wrapping the pair in a transaction is
 * not enough for the same reason; the isolation level has to be raised so both statements see one
 * snapshot. This is a read-only transaction, so REPEATABLE READ costs nothing but the guarantee.
 */
export function registerOrderReadRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/orders/:orderId', async (request): Promise<OrderSnapshot> => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      throw validationFailed('orderId must be a UUID.', params.error);
    }

    const snapshot = await db.transaction(
      async (tx) => loadOrderSnapshot(tx, params.data.orderId),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    if (snapshot === undefined) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'No order with that id.', {
        orderId: params.data.orderId,
      });
    }

    return snapshot;
  });
}
