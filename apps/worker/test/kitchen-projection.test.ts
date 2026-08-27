import { randomUUID } from 'node:crypto';

import type { DomainEvent, OrderSentToKitchenPayload } from '@pos/contracts';
import { kitchenTickets, processedEvents } from '@pos/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { applyKitchenEvent } from '../src/modules/kitchen/projection.js';
import { db, useTestDatabase } from './helpers.js';

useTestDatabase();

function sentToKitchen(
  orderId: string,
  version: number,
  items: OrderSentToKitchenPayload['items'],
): DomainEvent<OrderSentToKitchenPayload> {
  return {
    eventId: randomUUID(),
    eventType: 'OrderSentToKitchen',
    aggregateId: orderId,
    restaurantId: 'demo-restaurant',
    version,
    occurredAt: new Date().toISOString(),
    payload: { orderId, tableNumber: '12', items, totalCents: 1200 },
  };
}

const burger = [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }];
const pizza = [{ productId: 'pizza', name: 'Pizza', quantity: 1, unitPriceCents: 1500 }];

async function tickets(orderId: string) {
  return db().select().from(kitchenTickets).where(eq(kitchenTickets.orderId, orderId));
}

describe('§21.6 kitchen consumer idempotency', () => {
  it('applies the same event twice as one projection row and one processed_events row', async () => {
    const orderId = randomUUID();
    const event = sentToKitchen(orderId, 2, burger);

    expect(await applyKitchenEvent(db(), event)).toBe('applied');
    expect(await applyKitchenEvent(db(), event)).toBe('duplicate');

    const rows = await tickets(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceEventVersion).toBe(2);
    expect(rows[0]?.state).toBe('SENT_TO_KITCHEN');

    const marks = await db()
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, event.eventId));
    expect(marks).toHaveLength(1);
  });

  it('never moves the projection backwards on an older redelivery', async () => {
    const orderId = randomUUID();

    await applyKitchenEvent(db(), sentToKitchen(orderId, 5, pizza));
    // A different event id, so dedup cannot catch it: only the version guard can.
    expect(await applyKitchenEvent(db(), sentToKitchen(orderId, 3, burger))).toBe('stale');

    const rows = await tickets(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceEventVersion).toBe(5);
    expect(rows[0]?.items).toEqual(pizza);
  });

  it('advances the projection when a newer event arrives', async () => {
    const orderId = randomUUID();

    await applyKitchenEvent(db(), sentToKitchen(orderId, 2, burger));
    expect(await applyKitchenEvent(db(), sentToKitchen(orderId, 4, pizza))).toBe('applied');

    const rows = await tickets(orderId);
    expect(rows[0]?.sourceEventVersion).toBe(4);
    expect(rows[0]?.items).toEqual(pizza);
  });

  it('records events it does not project, so they are not re-read forever', async () => {
    const event: DomainEvent = {
      eventId: randomUUID(),
      eventType: 'OrderCreated',
      aggregateId: randomUUID(),
      restaurantId: 'demo-restaurant',
      version: 1,
      occurredAt: new Date().toISOString(),
      payload: {},
    };

    expect(await applyKitchenEvent(db(), event)).toBe('recorded');
    expect(await tickets(event.aggregateId)).toHaveLength(0);
    expect(
      await db().select().from(processedEvents).where(eq(processedEvents.eventId, event.eventId)),
    ).toHaveLength(1);
  });
});
