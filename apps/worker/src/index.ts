import { hostname } from 'node:os';

import { loadConfig } from '@pos/config';
import { closeDb, getDb } from '@pos/db';
import pino from 'pino';

import { publishOnce } from './modules/events/outbox-publisher.js';
import { connectBroker } from './shared/broker-session.js';
import { supervise } from './shared/broker-supervisor.js';
import { createKafka } from './shared/kafka.js';

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
    const connection = broker.current();

    if (connection === undefined) {
      await sleep(config.OUTBOX_POLL_MS);
      continue;
    }

    let drained = true;

    try {
      // The liveness predicate is this connection's own, taken with the transport it guards, so a
      // pass can never keep sending through a session that died underneath it.
      const result = await publishOnce(db, connection.transport, {
        ...publisherOptions,
        isTransportAlive: connection.isAlive,
      });
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
  logger.info(
    { workerId, brokerConnected: broker.current()?.isAlive() === true },
    'Worker heartbeat',
  );
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
