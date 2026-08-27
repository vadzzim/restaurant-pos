import { hostname } from 'node:os';

import { loadConfig } from '@pos/config';
import { closeDb, getDb } from '@pos/db';
import pino from 'pino';

import { publishOnce } from './modules/events/outbox-publisher.js';
import { startKitchenConsumer } from './modules/kitchen/consumer.js';
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
};

const kafka = createKafka(config);
await ensureOrderEventsTopic(kafka, config);

const producer = kafka.producer();
await producer.connect();
const transport = createKafkaTransport(producer, config.KAFKA_ORDER_EVENTS_TOPIC);

const kitchen = await startKitchenConsumer(kafka, db, config, logger);

logger.info({ workerId, topic: config.KAFKA_ORDER_EVENTS_TOPIC }, 'Worker started');

let running = true;

/** Sequential passes: a slow publish must not overlap the next tick and double-publish a lease. */
const publisherLoop = (async () => {
  while (running) {
    try {
      const result = await publishOnce(db, transport, publisherOptions);
      if (result.claimed > 0) {
        logger.info({ workerId, ...result }, 'outbox batch processed');
      }
    } catch (error) {
      logger.error({ err: error, workerId }, 'outbox publisher pass failed');
    }

    await sleep(config.OUTBOX_POLL_MS);
  }
})();

const heartbeat = setInterval(() => {
  logger.info({ workerId }, 'Worker heartbeat');
}, config.WORKER_HEARTBEAT_MS);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  running = false;
  clearInterval(heartbeat);
  try {
    await publisherLoop;
    await kitchen.stop();
    await producer.disconnect();
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
