import type { AppConfig } from '@pos/config';
import type { DomainEvent } from '@pos/contracts';
import { processedEvents, type Db } from '@pos/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Kafka } from 'kafkajs';

import { roomsFor, type RealtimeEmitter } from './broadcast.js';

export const REALTIME_CONSUMER = 'realtime';

export type RealtimeResult =
  /** Recorded and broadcast. */
  | 'emitted'
  /** Already recorded by this consumer: not broadcast again (§12.2). */
  | 'duplicate';

/**
 * §12.2, exactly as specified and no more. A WebSocket emit cannot join a database transaction,
 * so the order is: record the event as processed, commit, then emit.
 *
 * A crash between the commit and the emit loses that broadcast permanently. This window is real
 * and is not hidden. It is survivable only because of what the client does (§13): it deduplicates
 * by `eventId`, ignores any payload whose `version` is not greater than the one it holds, and
 * refetches the canonical snapshot on every reconnect. Delivery here is a hint; `GET /api/orders/:id`
 * is the truth.
 */
export async function handleRealtimeEvent(
  db: Db,
  emitter: RealtimeEmitter,
  event: DomainEvent,
): Promise<RealtimeResult> {
  const marked = await db
    .insert(processedEvents)
    .values({ eventId: event.eventId, consumerName: REALTIME_CONSUMER })
    .onConflictDoNothing()
    .returning();

  if (marked.length === 0) {
    return 'duplicate';
  }

  emitter.emit(roomsFor(event), event);

  return 'emitted';
}

export interface RealtimeConsumerHandle {
  stop: () => Promise<void>;
}

/**
 * One consumer group shared by every API instance (ADR 006): each event is handled once, by
 * whichever instance holds the partition, and the Redis adapter fans the broadcast out to sockets
 * attached to the others.
 */
export async function startRealtimeConsumer(
  kafka: Kafka,
  db: Db,
  emitter: RealtimeEmitter,
  config: AppConfig,
  logger: FastifyBaseLogger,
): Promise<RealtimeConsumerHandle> {
  const consumer = kafka.consumer({ groupId: config.REALTIME_CONSUMER_GROUP });

  await consumer.connect();
  await consumer.subscribe({ topic: config.KAFKA_ORDER_EVENTS_TOPIC, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString();
      if (raw === undefined) {
        return;
      }

      const event = JSON.parse(raw) as DomainEvent;
      const result = await handleRealtimeEvent(db, emitter, event);

      logger.info(
        {
          consumer: REALTIME_CONSUMER,
          eventId: event.eventId,
          eventType: event.eventType,
          orderId: event.aggregateId,
          restaurantId: event.restaurantId,
          version: event.version,
          traceId: event.traceId,
          result,
        },
        'realtime event handled',
      );
    },
  });

  return {
    stop: async () => {
      await consumer.disconnect();
    },
  };
}
