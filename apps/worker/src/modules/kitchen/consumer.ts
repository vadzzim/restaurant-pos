import type { AppConfig } from '@pos/config';
import type { DomainEvent } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { Kafka } from 'kafkajs';
import type { Logger } from 'pino';

import { applyKitchenEvent, KITCHEN_CONSUMER } from './projection.js';

export interface KitchenConsumerHandle {
  stop: () => Promise<void>;
}

export async function startKitchenConsumer(
  kafka: Kafka,
  db: Db,
  config: AppConfig,
  logger: Logger,
): Promise<KitchenConsumerHandle> {
  const consumer = kafka.consumer({ groupId: config.KITCHEN_CONSUMER_GROUP });

  await consumer.connect();
  await consumer.subscribe({ topic: config.KAFKA_ORDER_EVENTS_TOPIC, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString();
      if (raw === undefined) {
        return;
      }

      const event = JSON.parse(raw) as DomainEvent;
      const result = await applyKitchenEvent(db, event);

      logger.info(
        {
          consumer: KITCHEN_CONSUMER,
          eventId: event.eventId,
          eventType: event.eventType,
          orderId: event.aggregateId,
          restaurantId: event.restaurantId,
          version: event.version,
          traceId: event.traceId,
          result,
        },
        'kitchen event consumed',
      );
    },
  });

  return {
    stop: async () => {
      await consumer.disconnect();
    },
  };
}
