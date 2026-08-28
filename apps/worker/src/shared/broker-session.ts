import type { AppConfig } from '@pos/config';
import type { Db } from '@pos/db';
import { KafkaJSProtocolError, type Kafka } from 'kafkajs';
import type { Logger } from 'pino';

import type { EventTransport } from '../modules/events/outbox-publisher.js';
import { startKitchenConsumer } from '../modules/kitchen/consumer.js';
import type { BrokerSession } from './broker-supervisor.js';
import { createKafkaTransport, ensureOrderEventsTopic } from './kafka.js';

/**
 * What a live session hands the publisher. `isAlive` belongs to **this** session, not to the
 * supervisor: `broker.current()` still returns a session while its teardown is in flight — and
 * later returns its replacement — so a predicate written against the supervisor would let the rest
 * of a batch go through the very transport that just failed.
 */
export interface BrokerConnection {
  transport: EventTransport;
  isAlive: () => boolean;
}

/**
 * A protocol error is an answer, not a silence: the broker was reachable enough to reject this
 * record — `MESSAGE_TOO_LARGE` and its kind — so the connection is fine and the *event* is the
 * problem. Ending the session for it would take the kitchen consumer down with it and abandon every
 * unrelated row of the batch, once per retry, until the poison row dead-letters. Rejecting one
 * record is the per-event failure path's job, and it already does it (§10).
 *
 * Everything else — a socket that went away, a timeout, a broker that cannot be found — ends the
 * session, and so does anything unrecognised: pausing the publisher costs a reconnect, while
 * carrying on through a dead transport costs an `attempt_count` on every claimed row.
 */
export function isRecordRejection(error: unknown): boolean {
  return error instanceof KafkaJSProtocolError;
}

/**
 * **A failed send ends the session.** KafkaJS emits the producer's `DISCONNECT` for an explicit
 * disconnect, not for the ordinary case of the broker going away under an open socket — so that
 * instrumentation event alone would leave the session alive through an outage, the publisher would
 * keep calling `publishOnce`, and `attempt_count` would climb until good events dead-lettered.
 * That is the exact outcome this supervision exists to prevent (ADR 011). A send failure is the one
 * signal the worker is guaranteed to receive, so it is the one the session hangs on — except for a
 * record the broker itself rejected, which says nothing about the connection.
 *
 * `die` is called **before** the error is rethrown, so a publish loop that catches it and moves to
 * the next row already sees a dead session.
 */
export function guardTransport(inner: EventTransport, die: () => void): EventTransport {
  return {
    publish: async (event, key) => {
      try {
        await inner.publish(event, key);
      } catch (error) {
        if (!isRecordRejection(error)) {
          die();
        }
        throw error;
      }
    },
  };
}

/**
 * Everything the worker needs from Redpanda, built and torn down as one unit: the topic, the
 * producer the publisher writes through, and the kitchen consumer. They share a fate on purpose —
 * a worker with a producer but no consumer would publish events nobody projects.
 */
export async function connectBroker(
  kafka: Kafka,
  db: Db,
  config: AppConfig,
  logger: Logger,
): Promise<BrokerSession<BrokerConnection>> {
  await ensureOrderEventsTopic(kafka, config);

  let alive = true;
  let resolveDead!: () => void;
  const whenDead = new Promise<void>((resolve) => {
    resolveDead = resolve;
  });

  /** Synchronous, so a publish mid-batch sees it before the supervisor has torn anything down. */
  const die = (): void => {
    alive = false;
    resolveDead();
  };

  const producer = kafka.producer();
  // An explicit disconnect is one way a producer dies, and the cheapest to observe.
  producer.on(producer.events.DISCONNECT, die);
  await producer.connect();

  const kitchen = await startKitchenConsumer(kafka, db, config, logger, die).catch(
    async (error: unknown) => {
      // The producer is already connected; a consumer that fails to start must not leave it open.
      await producer.disconnect().catch(() => undefined);
      throw error;
    },
  );

  const transport = guardTransport(
    createKafkaTransport(producer, config.KAFKA_ORDER_EVENTS_TOPIC),
    die,
  );

  return {
    value: { transport, isAlive: () => alive },
    whenDead,
    stop: async () => {
      // Before awaiting anything: a publish racing this teardown must not be told the session is
      // usable while the consumer is still disconnecting.
      die();
      await kitchen.stop().catch(() => undefined);
      await producer.disconnect().catch(() => undefined);
    },
  };
}
