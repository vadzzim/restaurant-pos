import { randomUUID } from 'node:crypto';

import type { DomainEvent } from '@pos/contracts';
import { processedEvents } from '@pos/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { roomsFor, type RealtimeEmitter } from '../src/modules/realtime/broadcast.js';
import { handleRealtimeEvent, REALTIME_CONSUMER } from '../src/modules/realtime/consumer.js';
import { DEMO_RESTAURANT, db, useTestDatabase } from './helpers.js';

useTestDatabase();

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: randomUUID(),
    eventType: 'OrderItemAdded',
    aggregateId: randomUUID(),
    restaurantId: DEMO_RESTAURANT,
    version: 2,
    occurredAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

function recordingEmitter(): RealtimeEmitter & { calls: { rooms: string[]; id: string }[] } {
  const calls: { rooms: string[]; id: string }[] = [];
  return {
    calls,
    emit: (rooms, emitted) => {
      calls.push({ rooms, id: emitted.eventId });
    },
  };
}

describe('roomsFor', () => {
  it('always targets the order and the restaurant', () => {
    const added = event();
    expect(roomsFor(added)).toEqual([
      `order:${added.aggregateId}`,
      `restaurant:${DEMO_RESTAURANT}`,
    ]);
  });

  it('adds the kitchen room for OrderSentToKitchen', () => {
    const sent = event({ eventType: 'OrderSentToKitchen' });
    expect(roomsFor(sent)).toContain(`kitchen:${DEMO_RESTAURANT}`);
    expect(roomsFor(sent)).toHaveLength(3);
  });
});

describe('§12.2 the realtime consumer', () => {
  it('records the event before emitting, and emits once for a redelivery', async () => {
    const emitter = recordingEmitter();
    const redelivered = event({ eventType: 'OrderSentToKitchen' });

    expect(await handleRealtimeEvent(db(), emitter, redelivered)).toBe('emitted');
    expect(await handleRealtimeEvent(db(), emitter, redelivered)).toBe('duplicate');

    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.id).toBe(redelivered.eventId);
    expect(emitter.calls[0]?.rooms).toContain(`kitchen:${DEMO_RESTAURANT}`);

    const rows = await db()
      .select()
      .from(processedEvents)
      .where(
        and(
          eq(processedEvents.eventId, redelivered.eventId),
          eq(processedEvents.consumerName, REALTIME_CONSUMER),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('keeps its own offset marker, independent of the kitchen consumer', async () => {
    const emitter = recordingEmitter();
    const shared = event();

    // The kitchen consumer got there first; the realtime consumer must still emit.
    await db().insert(processedEvents).values({ eventId: shared.eventId, consumerName: 'kitchen' });

    expect(await handleRealtimeEvent(db(), emitter, shared)).toBe('emitted');

    const rows = await db()
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, shared.eventId));
    expect(rows.map((row) => row.consumerName).sort()).toEqual(['kitchen', 'realtime']);
  });
});
