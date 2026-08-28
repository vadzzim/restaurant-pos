import type {
  AddItemPayload,
  ChangeQuantityPayload,
  CreateOrderPayload,
  MenuItem,
  OrderItemSnapshot,
  OrderSnapshot,
  RemoveItemPayload,
} from '@pos/contracts';
import { calculateTotalCents, decide, type MutationCommand } from '@pos/domain';

import type { PendingMutationRecord } from '../persistence/db';

/**
 * The order as this device believes it to be: the last canonical snapshot with every queued
 * mutation folded onto it.
 *
 * **It is derived on read and never stored.** §14 says the UI updates optimistically and never
 * waits for the server, and the obvious way to do that — write the predicted order into the
 * `orders` table — would create the worst pair of writes in the milestone (a prediction on disk
 * with no queue row to justify it, or a queue row with no prediction) and would put a guess into a
 * table ADR 013 defines as canonical. Folding on read has neither problem: the projection is a
 * pure function of two persisted things, so a reload reproduces it exactly.
 *
 * **It is a prediction, not a fact.** Every canonical answer replaces the snapshot it folds onto,
 * the price comes from the menu rather than from the order, and the arithmetic here is a second
 * implementation of what the server does in SQL. That duplication is deliberate and bounded: the
 * *rules* — may this mutation apply at all — are `decide()`'s, imported from `@pos/domain`, the
 * same function the API calls, so an `ADD_ITEM` queued behind a `CANCEL` is not projected as
 * having applied. Only the item arithmetic is restated, because the server's version of it is an
 * atomic `insert … on conflict do update`, and lifting that into JavaScript to share it would
 * replace an upsert with a read-modify-write.
 */
export interface MenuLookup {
  (productId: string): Pick<MenuItem, 'name' | 'priceCents'> | undefined;
}

export function menuLookup(items: readonly MenuItem[]): MenuLookup {
  const byId = new Map(items.map((item) => [item.id, item]));
  return (productId) => byId.get(productId);
}

/** The `MutationCommand` a stored row describes. Storage keeps the payload; §8 wants the union. */
function commandOf(row: PendingMutationRecord): MutationCommand {
  return { type: row.type, payload: row.payload } as MutationCommand;
}

function withItems(order: OrderSnapshot, items: OrderItemSnapshot[]): OrderSnapshot {
  return { ...order, items, totalCents: calculateTotalCents(items) };
}

/**
 * One mutation folded onto the order it was queued against. `undefined` in means the order does
 * not exist yet, which only `CREATE_ORDER` can answer.
 */
function applyOne(
  order: OrderSnapshot | undefined,
  row: PendingMutationRecord,
  lookup: MenuLookup,
): OrderSnapshot | undefined {
  if (row.type === 'CREATE_ORDER' && order === undefined) {
    const payload = row.payload as CreateOrderPayload;
    return {
      id: row.orderId,
      restaurantId: row.restaurantId,
      tableNumber: payload.tableNumber,
      status: 'OPEN',
      // The order the server will have once this mutation applies. Predicting the version is what
      // lets the mutation behind this one be stamped at 1 rather than 0 — see `nextBaseVersion`.
      version: row.baseVersion + 1,
      totalCents: 0,
      items: [],
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    };
  }

  if (order === undefined) {
    return undefined;
  }

  // §8, from the same function the API calls. A queued mutation the domain would refuse is left
  // out of the picture rather than drawn optimistically: the operator should not watch an item
  // appear on an order this client already believes is cancelled.
  const decision = decide(order, commandOf(row));
  if (decision.kind !== 'apply') {
    return order;
  }

  const next: OrderSnapshot = {
    ...order,
    status: decision.nextStatus,
    version: row.baseVersion + 1,
    updatedAt: row.createdAt,
  };

  switch (row.type) {
    case 'ADD_ITEM': {
      const payload = row.payload as AddItemPayload;
      const product = lookup(payload.productId);
      const existing = next.items.find((item) => item.productId === payload.productId);

      if (existing !== undefined) {
        return withItems(
          next,
          next.items.map((item) =>
            item.productId === payload.productId
              ? { ...item, quantity: item.quantity + payload.quantity }
              : item,
          ),
        );
      }

      // A product the menu has not loaded yet: the line is still shown, priced at zero, because
      // hiding the operator's own action would be worse than a total that the server corrects.
      return withItems(next, [
        ...next.items,
        {
          productId: payload.productId,
          name: product?.name ?? payload.productId,
          quantity: payload.quantity,
          unitPriceCents: product?.priceCents ?? 0,
        },
      ]);
    }

    case 'REMOVE_ITEM': {
      const payload = row.payload as RemoveItemPayload;
      return withItems(
        next,
        next.items.filter((item) => item.productId !== payload.productId),
      );
    }

    case 'CHANGE_QUANTITY': {
      const payload = row.payload as ChangeQuantityPayload;
      return withItems(
        next,
        next.items.map((item) =>
          item.productId === payload.productId ? { ...item, quantity: payload.quantity } : item,
        ),
      );
    }

    default:
      // `SEND_TO_KITCHEN`, `PAY`, `CANCEL` and the two kitchen transitions move the status and
      // nothing else; `decision.nextStatus` above has already done that.
      return next;
  }
}

/** Every queued mutation for one order, folded onto the canonical snapshot in creation order. */
export function projectQueue(
  canonical: OrderSnapshot | undefined,
  queue: readonly PendingMutationRecord[],
  lookup: MenuLookup,
): OrderSnapshot | undefined {
  return queue.reduce<OrderSnapshot | undefined>(
    (order, row) => applyOne(order, row, lookup),
    canonical,
  );
}

/**
 * The `baseVersion` the next mutation for this order is stamped with.
 *
 * The **projected** version, not the canonical one. Offline, this client is the only writer, so it
 * can predict the versions the server will produce: a `CREATE_ORDER` at 0 projects v1, the
 * `ADD_ITEM` behind it is stamped at 1 and projects v2. That is why §19.2's four queued mutations
 * all apply on reconnect with nothing re-stamped — and why §19.3's first one conflicts the moment
 * another terminal has moved the order underneath the queue, which is the correct answer and the
 * point of the scenario.
 */
export function nextBaseVersion(projected: OrderSnapshot | undefined): number {
  return projected?.version ?? 0;
}
