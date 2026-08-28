import type { DomainEvent, KitchenTicketState, OrderSentToKitchenPayload } from '@pos/contracts';
import { kitchenTickets, processedEvents, type Db, type Tx } from '@pos/db';
import { and, eq, lt, sql } from 'drizzle-orm';

export const KITCHEN_CONSUMER = 'kitchen';

export type ProjectionResult =
  /** The projection changed. */
  | 'applied'
  /** The event was seen before: skipped safely (§12.1). */
  | 'duplicate'
  /** Recorded as processed, but this event type builds no ticket. */
  | 'recorded'
  /** An older redelivery that must not move the projection backwards. */
  | 'stale';

/**
 * The three events that move a ticket the kitchen already has. `OrderSentToKitchen` is not here
 * because it *creates* the ticket, and `OrderPaid` is not here because payment is not the
 * kitchen's business — a ticket that is READY stays READY when the table settles up.
 */
const STATE_BY_EVENT_TYPE: Readonly<Record<string, KitchenTicketState>> = {
  OrderPreparing: 'PREPARING',
  OrderReady: 'READY',
  OrderCancelled: 'CANCELLED',
};

/**
 * §12.1 in full: the side effect is a database write, so the dedup marker and the projection
 * commit together. Replaying an event and watching the ticket stay unchanged is then a real
 * demonstration rather than a claim.
 */
export async function applyKitchenEvent(db: Db, event: DomainEvent): Promise<ProjectionResult> {
  return db.transaction(async (tx) => {
    const marked = await tx
      .insert(processedEvents)
      .values({ eventId: event.eventId, consumerName: KITCHEN_CONSUMER })
      .onConflictDoNothing()
      .returning();

    if (marked.length === 0) {
      return 'duplicate';
    }

    if (event.eventType === 'OrderSentToKitchen') {
      return createTicket(tx, event);
    }

    const state = STATE_BY_EVENT_TYPE[event.eventType];
    if (state === undefined) {
      return 'recorded';
    }

    return advanceTicket(tx, event, state);
  });
}

async function createTicket(tx: Tx, event: DomainEvent): Promise<ProjectionResult> {
  const payload = event.payload as OrderSentToKitchenPayload;

  const upserted = await tx
    .insert(kitchenTickets)
    .values({
      orderId: event.aggregateId,
      restaurantId: event.restaurantId,
      tableNumber: payload.tableNumber,
      items: payload.items,
      state: 'SENT_TO_KITCHEN',
      sourceEventVersion: event.version,
    })
    .onConflictDoUpdate({
      target: kitchenTickets.orderId,
      set: {
        tableNumber: sql`excluded.table_number`,
        items: sql`excluded.items`,
        state: sql`excluded.state`,
        sourceEventVersion: sql`excluded.source_event_version`,
        updatedAt: sql`now()`,
      },
      // Redelivery is expected (§10 is at-least-once), and Kafka only orders within a
      // partition, so an older event must never overwrite a newer projection.
      setWhere: sql`${kitchenTickets.sourceEventVersion} < excluded.source_event_version`,
    })
    .returning();

  return upserted.length === 0 ? 'stale' : 'applied';
}

/**
 * A state change carries no items and no table, so it updates rather than upserts — and it may
 * legitimately find no ticket at all: `CANCEL` is valid on an `OPEN` order that the kitchen never
 * saw. That is `recorded`, not a failure and not staleness, and the distinction is worth keeping
 * because "the projection is behind" and "there was never a ticket" are debugged differently.
 */
async function advanceTicket(
  tx: Tx,
  event: DomainEvent,
  state: KitchenTicketState,
): Promise<ProjectionResult> {
  const advanced = await tx
    .update(kitchenTickets)
    .set({ state, sourceEventVersion: event.version, updatedAt: sql`now()` })
    .where(
      and(
        eq(kitchenTickets.orderId, event.aggregateId),
        lt(kitchenTickets.sourceEventVersion, event.version),
      ),
    )
    .returning();

  if (advanced.length > 0) {
    return 'applied';
  }

  const [existing] = await tx
    .select({ orderId: kitchenTickets.orderId })
    .from(kitchenTickets)
    .where(eq(kitchenTickets.orderId, event.aggregateId))
    .limit(1);

  return existing === undefined ? 'recorded' : 'stale';
}
