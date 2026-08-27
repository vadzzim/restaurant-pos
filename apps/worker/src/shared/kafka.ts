import type { AppConfig } from '@pos/config';
import type { DomainEvent } from '@pos/contracts';
import { Kafka, type Producer } from 'kafkajs';

import type { EventTransport } from '../modules/events/outbox-publisher.js';

export function createKafka(config: AppConfig): Kafka {
  return new Kafka({ clientId: config.KAFKA_CLIENT_ID, brokers: config.KAFKA_BROKERS });
}

/**
 * Created explicitly rather than left to broker auto-creation, so the partition count — and with
 * it the ordering guarantee per order key (§11) — is ours, not a default.
 */
export async function ensureOrderEventsTopic(kafka: Kafka, config: AppConfig): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      topics: [
        {
          topic: config.KAFKA_ORDER_EVENTS_TOPIC,
          numPartitions: config.KAFKA_ORDER_EVENTS_PARTITIONS,
        },
      ],
    });
  } finally {
    await admin.disconnect();
  }
}

/** Messages are keyed by `orderId`: one order's events stay ordered inside one partition (§11). */
export function createKafkaTransport(producer: Producer, topic: string): EventTransport {
  return {
    publish: async (event: DomainEvent, key: string) => {
      await producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(event) }],
      });
    },
  };
}
