import type { AppConfig } from '@pos/config';
import type { DomainEvent, OrderSentToKitchenPayload } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { Kafka } from 'kafkajs';
import type { Logger } from 'pino';

import type { PrintableTicket } from '../printing/ticket-hash.js';
import { applyKitchenEvent, KITCHEN_CONSUMER } from './projection.js';

export interface KitchenConsumerHandle {
  stop: () => Promise<void>;
}

/**
 * How a projected ticket reaches the print queue (§12.3). Optional, and best effort by contract:
 * see `enqueueTicket` for what a failure costs and what repairs it.
 */
export type PrintEnqueue = (ticket: PrintableTicket) => Promise<void>;

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
  enqueuePrint?: PrintEnqueue,
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

        if (result === 'applied' && event.eventType === 'OrderSentToKitchen') {
          await enqueueTicket(event, enqueuePrint, logger);
        }
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

/**
 * The enqueue, **after** the projection's transaction has committed (§7 forbids it inside, and a
 * queue that accepted a job for a projection that then rolled back would print a ticket for an
 * order that does not exist).
 *
 * Three properties, and each one is deliberate:
 *
 * - **It never throws.** A rejected `eachMessage` leaves the offset uncommitted, and Kafka would
 *   redeliver an event whose projection is already applied — for ever, if Redis is what is broken.
 *   The failure is logged and the ticket is repaired by the reconciliation sweep.
 * - **Only `applied`.** A redelivery answers `duplicate` and enqueues nothing, because this handler
 *   cannot tell whether the first delivery got as far as the queue. That window is the sweep's too,
 *   which is one repair mechanism for both instead of two.
 * - **Only `OrderSentToKitchen`.** It is the one event that creates a ticket; `PREPARING` and
 *   `READY` move a ticket that has already printed.
 */
async function enqueueTicket(
  event: DomainEvent,
  enqueuePrint: PrintEnqueue | undefined,
  logger: Logger,
): Promise<void> {
  if (enqueuePrint === undefined) {
    return;
  }

  const payload = event.payload as OrderSentToKitchenPayload;

  try {
    await enqueuePrint({
      orderId: event.aggregateId,
      restaurantId: event.restaurantId,
      tableNumber: payload.tableNumber,
      items: payload.items,
    });
  } catch (error) {
    logger.warn(
      { err: error, orderId: event.aggregateId, eventId: event.eventId },
      'could not enqueue a print job; the reconciliation sweep will pick the ticket up',
    );
  }
}
