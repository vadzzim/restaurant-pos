import { randomUUID } from 'node:crypto';

import { loadConfig } from '@pos/config';
import type { DomainEvent, OrderSentToKitchenPayload } from '@pos/contracts';
import { kitchenTickets, processedEvents } from '@pos/db';
import { eq } from 'drizzle-orm';
import type { Kafka } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyKitchenEvent, type ProjectionResult } from '../src/modules/kitchen/projection.js';
import { createKafka, ensureOrderEventsTopic } from '../src/shared/kafka.js';
import { db, useTestDatabase } from './helpers.js';

/**
 * §21.13 — a crash after the consumer's database commit and before its offset commit.
 *
 * This one has to run against a real broker. The window is *entirely* about Kafka's offset
 * bookkeeping: a fake that calls the handler twice proves nothing beyond §21.6, which is already
 * tested. So the test commits an offset for the first event, processes the second event without
 * committing it, disconnects, and lets a second consumer in the same group discover what the group
 * still believes. Kafka redelivers exactly the uncommitted event, and `processed_events` is what
 * keeps the projection still.
 */
useTestDatabase();

const suffix = randomUUID().slice(0, 8);

let kafka: Kafka;
let topic: string;
let groupId: string;
let cleanUpBroker: (() => Promise<void>) | undefined;

const items: OrderSentToKitchenPayload['items'] = [
  { productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 },
];

beforeAll(async () => {
  const base = loadConfig();
  topic = `restaurant.order.events.redelivery-${suffix}`;
  groupId = `kitchen-redelivery-${suffix}`;

  const config = { ...base, KAFKA_ORDER_EVENTS_TOPIC: topic, KITCHEN_CONSUMER_GROUP: groupId };
  kafka = createKafka(config);
  await ensureOrderEventsTopic(kafka, config);

  cleanUpBroker = async () => {
    const admin = kafka.admin();
    await admin.connect();
    try {
      await admin.deleteGroups([groupId]).catch(() => undefined);
      await admin.deleteTopics({ topics: [topic] });
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  };
});

afterAll(async () => {
  await cleanUpBroker?.().catch(() => undefined);
});

describe('§21.13 the consumer-commit-then-crash window', () => {
  it('redelivers the uncommitted event and leaves the projection where it was', async () => {
    const orderId = randomUUID();
    const created: DomainEvent = {
      eventId: randomUUID(),
      eventType: 'OrderSentToKitchen',
      aggregateId: orderId,
      restaurantId: 'demo-restaurant',
      version: 2,
      occurredAt: new Date().toISOString(),
      payload: { orderId, tableNumber: '9', items, totalCents: 1200 },
    };
    const preparing: DomainEvent = {
      ...created,
      eventId: randomUUID(),
      eventType: 'OrderPreparing',
      version: 3,
      payload: { orderId },
    };

    // One key, so both events land on one partition and one offset sequence.
    const producer = kafka.producer();
    await producer.connect();
    try {
      await producer.send({
        topic,
        messages: [created, preparing].map((event) => ({
          key: orderId,
          value: JSON.stringify(event),
        })),
      });
    } finally {
      await producer.disconnect().catch(() => undefined);
    }

    const beforeCrash = await consumeUntil(2, { commitFirstOnly: true });
    expect(beforeCrash.map((seen) => seen.event.eventId)).toEqual([
      created.eventId,
      preparing.eventId,
    ]);
    expect(beforeCrash.map((seen) => seen.result)).toEqual<ProjectionResult[]>([
      'applied',
      'applied',
    ]);

    const [projected] = await db()
      .select()
      .from(kitchenTickets)
      .where(eq(kitchenTickets.orderId, orderId));
    expect(projected?.state).toBe('PREPARING');
    expect(projected?.sourceEventVersion).toBe(3);

    // The second consumer inherits the group's committed offset, which names the event whose
    // projection already happened. `fromBeginning` cannot rescue it and is not meant to: the group
    // has an offset, so this is a redelivery of exactly one event, not a replay of the topic.
    const afterCrash = await consumeUntil(1, { commitFirstOnly: false });
    expect(afterCrash.map((seen) => seen.event.eventId)).toEqual([preparing.eventId]);
    expect(afterCrash[0]?.result).toBe('duplicate');

    const [reprojected] = await db()
      .select()
      .from(kitchenTickets)
      .where(eq(kitchenTickets.orderId, orderId));
    expect(reprojected?.state).toBe('PREPARING');
    expect(reprojected?.sourceEventVersion).toBe(3);
    // Not just the same state: the row was not rewritten at all.
    expect(reprojected?.updatedAt.getTime()).toBe(projected?.updatedAt.getTime());

    const processed = await db()
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, preparing.eventId));
    expect(processed).toHaveLength(1);
  });
});

interface SeenMessage {
  event: DomainEvent;
  result: ProjectionResult;
}

/**
 * Runs a consumer in the shared group until it has processed `count` messages, then disconnects.
 *
 * `autoCommit` is off throughout: every commit in this test is deliberate, because the whole point
 * is which offsets the group has and which it does not. With `commitFirstOnly`, the offset after
 * the first message is committed and nothing else is — the process "dies" holding a projection the
 * group has no record of.
 */
async function consumeUntil(
  count: number,
  { commitFirstOnly }: { commitFirstOnly: boolean },
): Promise<SeenMessage[]> {
  const seen: SeenMessage[] = [];
  const consumer = kafka.consumer({ groupId });

  let finished = (): void => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ partition, message }) => {
      const raw = message.value?.toString();
      if (raw === undefined) {
        return;
      }

      const event = JSON.parse(raw) as DomainEvent;
      const result = await applyKitchenEvent(db(), event);
      seen.push({ event, result });

      if (commitFirstOnly && seen.length === 1) {
        await consumer.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ]);
      }

      if (seen.length >= count) {
        finished();
      }
    },
  });

  try {
    await done;
  } finally {
    await consumer.disconnect().catch(() => undefined);
  }

  return seen;
}
