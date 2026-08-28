import { hostname } from 'node:os';

import { loadConfig, type AppConfig } from '@pos/config';
import { closeDb, getDb, type Db } from '@pos/db';
import type { Kafka } from 'kafkajs';
import pino, { type Logger } from 'pino';

import { publishOnce, type EventTransport } from './modules/events/outbox-publisher.js';
import { startKitchenConsumer } from './modules/kitchen/consumer.js';
import { supervise, type BrokerSession } from './shared/broker-supervisor.js';
import { createKafka, createKafkaTransport, ensureOrderEventsTopic } from './shared/kafka.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const { db } = getDb();

const workerId = `${hostname()}-${process.pid}`;
const publisherOptions = {
  workerId,
  batchSize: config.OUTBOX_BATCH_SIZE,
  leaseMs: config.OUTBOX_LEASE_MS,
  maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
  backoffBaseMs: config.OUTBOX_BACKOFF_BASE_MS,
  backoffMaxMs: config.OUTBOX_BACKOFF_MAX_MS,
  // The session below dies on the first failed send; this stops the rest of the batch being
  // charged an attempt for the same outage.
  isTransportAlive: () => broker.current() !== undefined,
};

const kafka = createKafka(config);

/**
 * Everything the worker needs from Redpanda, built and torn down as one unit: the topic, the
 * producer the publisher writes through, and the kitchen consumer. They share a fate on purpose —
 * a worker with a producer but no consumer would publish events nobody projects.
 */
async function connectBroker(
  broker: Kafka,
  database: Db,
  settings: AppConfig,
  log: Logger,
): Promise<BrokerSession<EventTransport>> {
  await ensureOrderEventsTopic(broker, settings);

  let died!: () => void;
  const whenDead = new Promise<void>((resolve) => {
    died = resolve;
  });

  const producer = broker.producer();
  // An explicit disconnect is one way a producer dies, and the cheapest to observe.
  producer.on(producer.events.DISCONNECT, () => {
    died();
  });
  await producer.connect();

  const kitchen = await startKitchenConsumer(broker, database, settings, log, died).catch(
    async (error: unknown) => {
      // The producer is already connected; a consumer that fails to start must not leave it open.
      await producer.disconnect().catch(() => undefined);
      throw error;
    },
  );

  const kafkaTransport = createKafkaTransport(producer, settings.KAFKA_ORDER_EVENTS_TOPIC);

  /**
   * **A failed send ends the session.** KafkaJS emits `DISCONNECT` for an explicit disconnect, not
   * for the ordinary case of the broker going away under an open socket — so the instrumentation
   * event alone would leave `broker.current()` defined through an outage, the publisher would keep
   * calling `publishOnce`, and `attempt_count` would climb until good events dead-lettered. That is
   * the exact outcome this supervision exists to prevent (ADR 011). A send failure is the one
   * signal the worker is guaranteed to receive, so it is the one this hangs the session on.
   *
   * The cost is one spent attempt per reconnect that succeeds and then fails again, which is the
   * honest reading of "we tried and it did not work" — and the outbox's own `next_attempt_at`
   * backoff, not the reconnect interval, is what paces the retries after the first couple.
   */
  const transport: EventTransport = {
    publish: async (event, key) => {
      try {
        await kafkaTransport.publish(event, key);
      } catch (error) {
        died();
        throw error;
      }
    },
  };

  return {
    value: transport,
    whenDead,
    stop: async () => {
      await kitchen.stop().catch(() => undefined);
      await producer.disconnect().catch(() => undefined);
      died();
    },
  };
}

const broker = supervise({
  name: 'redpanda',
  retryMs: config.WORKER_BROKER_RETRY_MS,
  logger,
  connect: async () => connectBroker(kafka, db, config, logger),
});

logger.info({ workerId, topic: config.KAFKA_ORDER_EVENTS_TOPIC }, 'Worker started');

let running = true;

/**
 * Sequential passes: a slow publish must not overlap the next tick and double-publish a lease.
 *
 * The loop idles while the broker is unreachable rather than publishing into a void. A failed pass
 * costs an `attempt_count` on every claimed row, so publishing during an outage would dead-letter
 * events whose only fault was arriving at the wrong minute (ADR 011).
 */
const publisherLoop = (async () => {
  while (running) {
    const transport = broker.current();

    if (transport === undefined) {
      await sleep(config.OUTBOX_POLL_MS);
      continue;
    }

    let drained = true;

    try {
      const result = await publishOnce(db, transport, publisherOptions);
      if (result.claimed > 0) {
        logger.info({ workerId, ...result }, 'outbox batch processed');
      }
      // A pass claims at most one event per order, to keep that order's events in version order.
      // Waiting a full poll interval between them would make a three-event order take seconds to
      // reach the kitchen, so a productive pass is followed immediately by the next one.
      drained = result.published === 0;
    } catch (error) {
      logger.error({ err: error, workerId }, 'outbox publisher pass failed');
    }

    if (drained) {
      await sleep(config.OUTBOX_POLL_MS);
    }
  }
})();

const heartbeat = setInterval(() => {
  logger.info({ workerId, brokerConnected: broker.current() !== undefined }, 'Worker heartbeat');
}, config.WORKER_HEARTBEAT_MS);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  running = false;
  clearInterval(heartbeat);
  try {
    await publisherLoop;
    await broker.stop();
    await closeDb();
  } catch (error) {
    logger.error({ err: error, signal }, 'Failed to shut down worker cleanly');
    process.exitCode = 1;
  }
  logger.info({ signal }, 'Worker stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
