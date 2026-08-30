import type { AppConfig } from '@pos/config';
import type { DomainEvent } from '@pos/contracts';
import { processedEvents, type Db } from '@pos/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Consumer, Kafka } from 'kafkajs';
import { z } from 'zod';

import { incrementCounter } from '../debug/application/counters.js';
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
 * refetches the canonical snapshot on every reconnect. Delivery here is a hint;
 * `GET /api/orders/:id` is the truth.
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

const envelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().min(1),
  aggregateId: z.uuid(),
  restaurantId: z.string().min(1),
  version: z.number().int().nonnegative(),
  occurredAt: z.string().min(1),
  traceId: z.string().optional(),
  payload: z.unknown(),
});

/**
 * A message this consumer cannot understand must not become a crash loop. Anything from another
 * producer, a half-written value or an envelope this build predates is logged and skipped.
 *
 * **The skip is terminal, and that is a real cost.** Returning from `eachMessage` counts as
 * success, so KafkaJS commits the offset and this consumer group will never be offered the message
 * again — a later build cannot pick it up. The alternative, throwing, would stall the partition
 * forever behind one bad message and freeze every screen in the restaurant. Between silently
 * losing one broadcast and losing all of them, this loses the one, loudly: the skip is logged at
 * `error` with the raw payload so it is recoverable by hand from the topic, which is still within
 * its retention. A consumer-side dead-letter topic is the real answer and is out of scope for M4 —
 * `outbox_events` already dead-letters on the *publish* side, and the read side would need its own.
 *
 * Genuine failures — the database being unreachable — still throw, because those must be retried.
 */
export function parseDomainEvent(raw: string, logger: FastifyBaseLogger): DomainEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    logger.error(
      { err: error, raw: raw.slice(0, 500) },
      'realtime consumer permanently skipped a message that is not JSON; its offset is committed',
    );
    return undefined;
  }

  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, raw: raw.slice(0, 500) },
      'realtime consumer permanently skipped a message that is not a DomainEvent; its offset is committed',
    );
    return undefined;
  }

  return parsed.data as DomainEvent;
}

export interface RealtimeConsumerHandle {
  stop: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connectConsumer(
  kafka: Kafka,
  db: Db,
  emitter: RealtimeEmitter,
  config: AppConfig,
  logger: FastifyBaseLogger,
  onFatalCrash: () => void,
  onDuplicateEvent: () => void,
): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: config.REALTIME_CONSUMER_GROUP });

  // Registered before `run`, so a crash during startup is not missed. KafkaJS restarts itself for
  // retriable failures; `restart: false` means it has given up and this instance is now deaf.
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    logger.error(
      { err: payload.error, restart: payload.restart, groupId: payload.groupId },
      'realtime consumer crashed',
    );
    if (!payload.restart) {
      onFatalCrash();
    }
  });

  // `subscribe` and `run` can fail after `connect` has already opened sockets. The caller only
  // ever sees the returned handle, so a consumer that dies in between has to clean up after
  // itself here — otherwise every supervisor retry would leak another live connection.
  try {
    await consumer.connect();
    await consumer.subscribe({ topic: config.KAFKA_ORDER_EVENTS_TOPIC, fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ message }) => {
        const raw = message.value?.toString();
        if (raw === undefined) {
          return;
        }

        const event = parseDomainEvent(raw, logger);
        if (event === undefined) {
          return;
        }

        const result = await handleRealtimeEvent(db, emitter, event);

        // §20, at the one place the outcome is known. The broadcast count is this instance's own
        // and resets with the process; the duplicate count is shared with the worker's kitchen
        // consumer, because "how many redeliveries did dedup absorb" is one number about the
        // system and neither process owns it.
        if (result === 'emitted') {
          incrementCounter('realtimeEventsBroadcast');
        } else {
          onDuplicateEvent();
        }

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
  } catch (error) {
    await consumer.disconnect().catch(() => undefined);
    throw error;
  }

  return consumer;
}

/**
 * One consumer group shared by every API instance (ADR 006): each event is handled once, by
 * whichever instance holds the partition, and the Redis adapter fans the broadcast out to sockets
 * attached to the others.
 *
 * Supervised rather than started once. Redpanda is a soft dependency of the API (§17), so a
 * consumer that cannot start yet is retried in the background — and, just as importantly, one that
 * dies *after* starting is restarted. Without that, a single unrecoverable failure would leave the
 * API serving reads and writes with every screen silently frozen until someone restarted the
 * process, which is exactly the kind of half-dead state this architecture is supposed to avoid.
 */
export function superviseRealtimeConsumer(
  kafka: Kafka,
  db: Db,
  emitter: RealtimeEmitter,
  config: AppConfig,
  logger: FastifyBaseLogger,
  /**
   * How a suppressed duplicate is recorded. Injected and defaulted to a no-op because it is a
   * Redis write and Redis is soft: an API built without it counts nothing rather than failing.
   */
  onDuplicateEvent: () => void = () => undefined,
): RealtimeConsumerHandle {
  let wanted = true;
  let current: Consumer | undefined;
  let wake: (() => void) | undefined;

  const loop = (async () => {
    while (wanted) {
      const died = new Promise<void>((resolve) => {
        wake = resolve;
      });

      try {
        current = await connectConsumer(
          kafka,
          db,
          emitter,
          config,
          logger,
          () => wake?.(),
          onDuplicateEvent,
        );
        logger.info({ groupId: config.REALTIME_CONSUMER_GROUP }, 'realtime consumer running');

        await died;

        await current.disconnect().catch(() => undefined);
        current = undefined;

        if (!wanted) {
          return;
        }
        logger.warn('realtime consumer stopped; restarting');
      } catch (error) {
        logger.warn(
          { err: error, retryInMs: config.REALTIME_CONSUMER_RETRY_MS },
          'realtime consumer could not start; live updates are degraded, writes are unaffected',
        );
        await current?.disconnect().catch(() => undefined);
        current = undefined;
      }

      if (wanted) {
        await sleep(config.REALTIME_CONSUMER_RETRY_MS);
      }
    }
  })();

  return {
    stop: async () => {
      wanted = false;
      wake?.();
      await loop;
      await current?.disconnect().catch(() => undefined);
    },
  };
}
