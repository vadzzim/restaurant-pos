import type { DomainEvent, OrderSentToKitchenPayload } from '@pos/contracts';
import { kitchenTickets, processedEvents, type Db } from '@pos/db';
import { sql } from 'drizzle-orm';

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

    if (event.eventType !== 'OrderSentToKitchen') {
      return 'recorded';
    }

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
  });
}
