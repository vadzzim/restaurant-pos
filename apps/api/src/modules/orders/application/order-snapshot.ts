import type { OrderSnapshot } from '@pos/contracts';
import { orderItems, orders, type Db, type Tx } from '@pos/db';
import { asc, eq } from 'drizzle-orm';

export type Executor = Db | Tx;

/** The canonical view of an order: the row plus its items, exactly as §3 defines the aggregate. */
export async function loadOrderSnapshot(
  executor: Executor,
  orderId: string,
): Promise<OrderSnapshot | undefined> {
  const [order] = await executor.select().from(orders).where(eq(orders.id, orderId)).limit(1);

  if (order === undefined) {
    return undefined;
  }

  const items = await executor
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.productId));

  return {
    id: order.id,
    restaurantId: order.restaurantId,
    tableNumber: order.tableNumber,
    status: order.status,
    version: order.version,
    totalCents: order.totalCents,
    items: items.map((item) => ({
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
