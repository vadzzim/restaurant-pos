import type { AppConfig } from '@pos/config';
import type { DomainEvent } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { Kafka } from 'kafkajs';
import type { Logger } from 'pino';

import { applyKitchenEvent, KITCHEN_CONSUMER } from './projection.js';

export interface KitchenConsumerHandle {
  stop: () => Promise<void>;
}

/**
 * `onFatalCrash` fires when KafkaJS has stopped restarting itself, which is the only way this
 * consumer can go quiet without anyone noticing. The broker supervisor rebuilds the session; without
 * the callback the worker would keep publishing while no kitchen ticket was ever projected again.
 */
export async function startKitchenConsumer(
  kafka: Kafka,
  db: Db,
  config: AppConfig,
  logger: Logger,
  onFatalCrash: () => void = () => undefined,
): Promise<KitchenConsumerHandle> {
  const consumer = kafka.consumer({ groupId: config.KITCHEN_CONSUMER_GROUP });

  // Registered before `run`, so a crash during startup is not missed.
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    logger.error(
      { err: payload.error, restart: payload.restart, groupId: payload.groupId },
      'kitchen consumer crashed',
    );
    if (!payload.restart) {
      onFatalCrash();
    }
  });

  // `subscribe` and `run` can fail after `connect` has opened sockets. A consumer that dies in
  // between has to clean up after itself, or every supervisor retry leaks another connection.
  try {
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
  } catch (error) {
    await consumer.disconnect().catch(() => undefined);
    throw error;
  }

  return {
    stop: async () => {
      await consumer.disconnect();
    },
  };
}
