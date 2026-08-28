import { randomUUID } from 'node:crypto';

import type { DomainEvent } from '@pos/contracts';
import { orders, outboxEvents } from '@pos/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  publishOnce,
  type EventTransport,
  type PublisherOptions,
} from '../src/modules/events/outbox-publisher.js';
import { db, useTestDatabase } from './helpers.js';

useTestDatabase();

const options: PublisherOptions = {
  workerId: 'worker-under-test',
  batchSize: 10,
  leaseMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
};

function recordingTransport(): EventTransport & { sent: DomainEvent[]; keys: string[] } {
  const sent: DomainEvent[] = [];
  const keys: string[] = [];
  return {
    sent,
    keys,
    publish: async (event, key) => {
      sent.push(event);
      keys.push(key);
    },
  };
}

const failingTransport: EventTransport = {
  publish: async () => {
    throw new Error('broker unreachable');
  },
};

async function seedEvent(orderId: string, eventVersion: number): Promise<string> {
  const eventId = randomUUID();

  await db().insert(outboxEvents).values({
    id: eventId,
    aggregateId: orderId,
    aggregateType: 'order',
    restaurantId: 'demo-restaurant',
    eventType: 'OrderItemAdded',
    eventVersion,
    payload: { orderId },
  });

  return eventId;
}

async function seedOrderWithEvent(): Promise<{ orderId: string; eventId: string }> {
  const orderId = randomUUID();
  const eventId = randomUUID();

  await db().insert(orders).values({
    id: orderId,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status: 'SENT_TO_KITCHEN',
    version: 2,
    totalCents: 1200,
  });

  await db()
    .insert(outboxEvents)
    .values({
      id: eventId,
      aggregateId: orderId,
      aggregateType: 'order',
      restaurantId: 'demo-restaurant',
      eventType: 'OrderSentToKitchen',
      eventVersion: 2,
      payload: { orderId, tableNumber: '12', items: [], totalCents: 1200 },
    });

  return { orderId, eventId };
}

async function eventRow(eventId: string) {
  const [row] = await db().select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
  return row;
}

describe('the outbox publisher', () => {
  it('claims, publishes outside the transaction, then marks the row published', async () => {
    const { orderId, eventId } = await seedOrderWithEvent();
    const transport = recordingTransport();

    const result = await publishOnce(db(), transport, options);

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0, deadLettered: 0, abandoned: 0 });
    expect(transport.sent[0]?.eventId).toBe(eventId);
    // The message key is the order id, which is what keeps one order's events in one partition.
    expect(transport.keys).toEqual([orderId]);

    const row = await eventRow(eventId);
    expect(row?.publishedAt).not.toBeNull();
    expect(row?.claimedBy).toBeNull();
    expect(row?.claimUntil).toBeNull();
  });

  it('does not claim a row that is already published', async () => {
    const { eventId } = await seedOrderWithEvent();
    const transport = recordingTransport();

    await publishOnce(db(), transport, options);
    const second = await publishOnce(db(), transport, options);

    expect(second.claimed).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(eventId).toBeDefined();
  });

  it('schedules a retry with backoff when the broker rejects the publish', async () => {
    const { eventId } = await seedOrderWithEvent();

    const result = await publishOnce(db(), failingTransport, options);

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1, deadLettered: 0, abandoned: 0 });

    const row = await eventRow(eventId);
    expect(row?.publishedAt).toBeNull();
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastError).toContain('broker unreachable');
    expect(row?.deadLetteredAt).toBeNull();
    expect(row?.claimedBy).toBeNull();
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('dead-letters a row that exhausts its attempts instead of dropping it', async () => {
    const { eventId } = await seedOrderWithEvent();
    const impatient: PublisherOptions = { ...options, backoffBaseMs: 1, backoffMaxMs: 1 };

    for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
      await publishOnce(db(), failingTransport, impatient);
      // The backoff is one millisecond, so the row is claimable again on the next pass.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const row = await eventRow(eventId);
    expect(row?.attemptCount).toBe(options.maxAttempts);
    expect(row?.deadLetteredAt).not.toBeNull();

    const afterDeadLetter = await publishOnce(db(), failingTransport, impatient);
    expect(afterDeadLetter.claimed).toBe(0);
  });
});

describe('per-order ordering', () => {
  it('claims only the earliest pending event of an order, so v2 cannot overtake v1', async () => {
    const orderId = randomUUID();
    const first = await seedEvent(orderId, 1);
    const second = await seedEvent(orderId, 2);
    const transport = recordingTransport();

    const pass = await publishOnce(db(), transport, options);
    expect(pass.claimed).toBe(1);
    expect(transport.sent.map((event) => event.eventId)).toEqual([first]);

    await publishOnce(db(), transport, options);
    expect(transport.sent.map((event) => event.eventId)).toEqual([first, second]);
    expect(transport.sent.map((event) => event.version)).toEqual([1, 2]);
  });

  it('holds later events of the same order back while an earlier one is retrying', async () => {
    const orderId = randomUUID();
    const first = await seedEvent(orderId, 1);
    await seedEvent(orderId, 2);
    const impatient: PublisherOptions = { ...options, backoffBaseMs: 1, backoffMaxMs: 1 };

    await publishOnce(db(), failingTransport, impatient);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // v1 is back in the queue: the next pass must retry it, never skip ahead to v2.
    const transport = recordingTransport();
    const retry = await publishOnce(db(), transport, impatient);

    expect(retry.published).toBe(1);
    expect(transport.sent.map((event) => event.eventId)).toEqual([first]);
  });

  it('still batches events belonging to different orders', async () => {
    const firstOrder = randomUUID();
    const secondOrder = randomUUID();
    await seedEvent(firstOrder, 1);
    await seedEvent(secondOrder, 1);
    const transport = recordingTransport();

    const pass = await publishOnce(db(), transport, options);

    expect(pass.claimed).toBe(2);
    expect(pass.published).toBe(2);
  });
});

/**
 * The M6 review's P1, from the other end. The supervisor kills the session on the first failed
 * send, and this is what stops the rest of that batch being charged an `attempt_count` for the same
 * outage — otherwise a full batch would burn fifty attempts on one broker blip, and dead-lettering
 * would stop meaning "this event is bad".
 */
describe('a batch interrupted by the broker going away', () => {
  it('spends one attempt and abandons the rest of the claim untouched', async () => {
    const first = await seedOrderWithEvent();
    const second = await seedOrderWithEvent();
    const third = await seedOrderWithEvent();

    let alive = true;
    const dyingTransport: EventTransport = {
      publish: async () => {
        alive = false;
        throw new Error('broker unreachable');
      },
    };

    const result = await publishOnce(db(), dyingTransport, {
      ...options,
      isTransportAlive: () => alive,
    });

    expect(result).toMatchObject({ claimed: 3, published: 0, failed: 1, abandoned: 2 });

    const attempts = await Promise.all(
      [first, second, third].map(async ({ eventId }) => (await eventRow(eventId))?.attemptCount),
    );
    // Exactly one row learned anything; the other two are untouched and keep their lease.
    expect(attempts.filter((count) => count === 1)).toHaveLength(1);
    expect(attempts.filter((count) => count === 0)).toHaveLength(2);
  });
});
