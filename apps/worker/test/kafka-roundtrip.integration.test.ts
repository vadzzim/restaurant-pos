import { randomUUID } from 'node:crypto';

import { loadConfig } from '@pos/config';
import type { OrderSentToKitchenPayload } from '@pos/contracts';
import { kitchenTickets, outboxEvents } from '@pos/db';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { publishOnce, type PublisherOptions } from '../src/modules/events/outbox-publisher.js';
import {
  startKitchenConsumer,
  type KitchenConsumerHandle,
} from '../src/modules/kitchen/consumer.js';
import { createKafka, createKafkaTransport, ensureOrderEventsTopic } from '../src/shared/kafka.js';
import { db, useTestDatabase } from './helpers.js';

/**
 * The one seam `pnpm test` cannot cover. Everywhere else the publisher runs against a fake
 * transport and both consumers are called as functions, so the whole of KafkaJS — the producer, the
 * topic, the key-to-partition mapping, the consumer group, the envelope surviving JSON both ways —
 * is asserted by nothing. This test runs it for real:
 *
 *   outbox row -> publishOnce -> producer -> Redpanda -> consumer group -> kitchen_tickets
 *
 * It uses its own topic and its own consumer group, both unique per run. Against
 * `restaurant.order.events` the worker the user has running for the demo would consume these
 * events and write kitchen tickets for orders that do not exist in the demo database.
 */

useTestDatabase();

const logger = pino({ level: 'silent' });
const suffix = randomUUID().slice(0, 8);

let kitchen: KitchenConsumerHandle | undefined;
let cleanUpBroker: (() => Promise<void>) | undefined;
let transport: ReturnType<typeof createKafkaTransport>;

const publisherOptions: PublisherOptions = {
  workerId: `roundtrip-${suffix}`,
  batchSize: 10,
  leaseMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
};

beforeAll(async () => {
  const base = loadConfig();
  const config = {
    ...base,
    KAFKA_ORDER_EVENTS_TOPIC: `restaurant.order.events.test-${suffix}`,
    KITCHEN_CONSUMER_GROUP: `kitchen-test-${suffix}`,
  };

  const kafka = createKafka(config);
  await ensureOrderEventsTopic(kafka, config);

  const producer = kafka.producer();
  await producer.connect();
  transport = createKafkaTransport(producer, config.KAFKA_ORDER_EVENTS_TOPIC);

  kitchen = await startKitchenConsumer(kafka, db(), config, logger);

  // A topic per run would otherwise accumulate in the broker the user keeps for the demo.
  cleanUpBroker = async () => {
    await producer.disconnect().catch(() => undefined);
    const admin = kafka.admin();
    await admin.connect();
    try {
      await admin.deleteTopics({ topics: [config.KAFKA_ORDER_EVENTS_TOPIC] });
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  };
});

afterAll(async () => {
  await kitchen?.stop().catch(() => undefined);
  await cleanUpBroker?.().catch(() => undefined);
});

const items: OrderSentToKitchenPayload['items'] = [
  { productId: 'burger', name: 'Burger', quantity: 2, unitPriceCents: 1200 },
];

/**
 * Polls rather than waits a fixed time: a consumer group's first assignment takes as long as the
 * rebalance takes, and a sleep long enough to be safe would be long enough to be useless.
 */
async function waitForTicket(orderId: string, timeoutMs = 60_000): Promise<{ state: string }> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const rows = await db()
      .select()
      .from(kitchenTickets)
      .where(eq(kitchenTickets.orderId, orderId));
    const row = rows[0];
    if (row !== undefined) {
      return row;
    }
    if (Date.now() > deadline) {
      throw new Error(`no kitchen ticket for ${orderId} after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('outbox to projection, through a real broker', () => {
  it('publishes an outbox row and projects it into a kitchen ticket', async () => {
    const orderId = randomUUID();
    const eventId = randomUUID();
    const traceId = `trace-${suffix}`;

    await db()
      .insert(outboxEvents)
      .values({
        id: eventId,
        aggregateId: orderId,
        aggregateType: 'order',
        restaurantId: 'demo-restaurant',
        eventType: 'OrderSentToKitchen',
        eventVersion: 3,
        traceId,
        payload: { orderId, tableNumber: '14', items, totalCents: 2400 },
      });

    const result = await publishOnce(db(), transport, publisherOptions);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);

    const ticket = await waitForTicket(orderId);
    expect(ticket.state).toBe('SENT_TO_KITCHEN');

    const [row] = await db().select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
    expect(row?.publishedAt).not.toBeNull();
    expect(row?.deadLetteredAt).toBeNull();
    // The trace id the API put on the request survives the whole trip, which is what makes a
    // single correlation field worth carrying across three processes (§20).
    expect(row?.traceId).toBe(traceId);
  });
});
