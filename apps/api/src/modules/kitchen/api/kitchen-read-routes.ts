import type { KitchenTicket, KitchenTicketState, OrderItemSnapshot } from '@pos/contracts';
import { kitchenTickets, type Db } from '@pos/db';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../../../shared/errors.js';

const querySchema = z.object({ restaurantId: z.string().min(1) });

/**
 * The kitchen screen reads the projection the kitchen consumer builds (§12.1, §16), not `orders`.
 * §17's endpoint list has no read for it — `GET /api/restaurants/:id/orders` reads the aggregate —
 * so this route is an addition, recorded in docs/build-log.md.
 */
export function registerKitchenReadRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/kitchen/tickets', async (request): Promise<KitchenTicket[]> => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'restaurantId is required.', {
        issues: query.error.issues,
      });
    }

    const rows = await db
      .select()
      .from(kitchenTickets)
      .where(eq(kitchenTickets.restaurantId, query.data.restaurantId))
      .orderBy(desc(kitchenTickets.updatedAt));

    return rows.map((row) => ({
      orderId: row.orderId,
      restaurantId: row.restaurantId,
      tableNumber: row.tableNumber,
      // `items` is jsonb; the consumer writes exactly the §11 item shape into it.
      items: row.items as OrderItemSnapshot[],
      // `state` is text in the schema; the kitchen consumer writes only KITCHEN_TICKET_STATES.
      state: row.state as KitchenTicketState,
      sourceEventVersion: row.sourceEventVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  });
}
