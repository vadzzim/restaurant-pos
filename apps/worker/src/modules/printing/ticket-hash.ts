import { createHash } from 'node:crypto';

import type { OrderItemSnapshot } from '@pos/contracts';

/** Everything the fake printer needs, and everything the hash is taken over. */
export interface PrintableTicket {
  orderId: string;
  restaurantId: string;
  tableNumber: string;
  items: OrderItemSnapshot[];
}

/**
 * The identity of a ticket, and therefore the id of its `print_jobs` row and of its BullMQ job.
 *
 * Two call sites must agree on it or the whole milestone comes apart: the kitchen consumer hashes
 * the `OrderSentToKitchen` payload, and the reconciliation sweep hashes a `kitchen_tickets` row it
 * reads back later. They agree because the projection stores the payload's items verbatim and
 * because this function normalises rather than trusting the shape it is given —
 * `JSON.stringify` over a raw items array would make the hash depend on key order and on how
 * PostgreSQL chose to return the JSON.
 *
 * `restaurantId` is deliberately **not** part of the hash. An order belongs to exactly one
 * restaurant, so including it could only ever make the same paper hash differently.
 */
export function ticketHash(ticket: PrintableTicket): string {
  const canonical = JSON.stringify({
    orderId: ticket.orderId,
    tableNumber: ticket.tableNumber,
    items: [...ticket.items]
      .sort((left, right) => left.productId.localeCompare(right.productId))
      .map((item) => [item.productId, item.quantity, item.unitPriceCents]),
  });

  return createHash('sha256').update(canonical).digest('hex');
}
