import { hostname } from 'node:os';

import { loadConfig } from '@pos/config';
import { closeDb, getDb } from '@pos/db';
import pino from 'pino';

import { readOutboxControls, watchOutboxControls } from './modules/events/outbox-controls.js';
import { maxPublishDelayMs, publishOnce } from './modules/events/outbox-publisher.js';
import { createPrintQueue } from './modules/printing/print-queue.js';
import { startPrintWorker } from './modules/printing/print-worker.js';
import { httpPrinter } from './modules/printing/printer-client.js';
import { startPrintReconciler } from './modules/printing/reconcile.js';
import { connectBroker } from './shared/broker-session.js';
import { supervise } from './shared/broker-supervisor.js';
import { createKafka } from './shared/kafka.js';
import { BLOCKING_CONNECTION, connectRedis, producerConnection } from './shared/redis.js';

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

// Two connections, and deliberately not the same options: BullMQ's worker blocks on Redis, while
// the producer is awaited by the kitchen consumer and must fail rather than wait. See shared/redis.
const queueRedis = connectRedis(
  config.REDIS_URL,
  producerConnection(config.PRINT_ENQUEUE_TIMEOUT_MS),
  'print-queue',
  logger,
);
const printWorkerRedis = connectRedis(
  config.REDIS_URL,
  BLOCKING_CONNECTION,
  'print-worker',
  logger,
);

const printQueue = createPrintQueue(queueRedis, {
  queueName: config.PRINT_QUEUE_NAME,
  maxAttempts: config.PRINT_MAX_ATTEMPTS,
  backoffBaseMs: config.PRINT_BACKOFF_BASE_MS,
  enqueueTimeoutMs: config.PRINT_ENQUEUE_TIMEOUT_MS,
});

const printWorker = startPrintWorker(
  printWorkerRedis,
  db,
  httpPrinter({ url: config.PRINTER_URL, timeoutMs: config.PRINTER_TIMEOUT_MS }),
  logger,
  { queueName: config.PRINT_QUEUE_NAME, maxAttempts: config.PRINT_MAX_ATTEMPTS },
);

// The repair for every lost enqueue (§12.3). It reads `kitchen_tickets`, so it works whether the
// job was lost to a crash, to a redelivery that deduplicated, or to Redis being empty.
const printReconciler = startPrintReconciler(
  db,
  printQueue,
  config.PRINT_RECONCILE_MS,
  { staleAfterMs: config.PRINT_STALE_MS, limit: config.PRINT_RECONCILE_LIMIT },
  logger,
);

// Awaited before the loop starts, so a worker that boots while the publisher is paused honours the
// pause on its very first pass instead of draining a backlog a human deliberately stopped.
const controls = await watchOutboxControls(
  async () => readOutboxControls(db),
  config.OUTBOX_POLL_MS,
  logger,
);

const broker = supervise({
  name: 'redpanda',
  retryMs: config.WORKER_BROKER_RETRY_MS,
  logger,
  connect: async () => connectBroker(kafka, db, config, logger, printQueue.enqueue),
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

    // Paused means paused before the claim, not just before the send: a pass that claimed a batch
    // and then released it would still have held every one of those rows for a round trip.
    if (connection === undefined || controls.current().paused) {
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
        controls: controls.current,
        onLeaseOverrun: connection.endSession,
      });
      if (result.claimed > 0) {
        logger.info({ workerId, ...result }, 'outbox batch processed');
      }
      if (result.stoppedBecause === 'lease' && result.published === 0) {
        // The pass claimed rows, spent its whole lease budget and published nothing. With a sane
        // delay that means the broker is slow; with a delay someone wrote straight into the table
        // it means the switch is a permanent pause, and the loop would spin claiming and releasing.
        logger.warn(
          {
            workerId,
            publishDelayMs: controls.current().publishDelayMs,
            maxPublishDelayMs: maxPublishDelayMs(config.OUTBOX_LEASE_MS),
          },
          'a pass spent its lease without publishing: the broker is slow, or the delay is too large',
        );
      }
      if (result.reclaimed > 0) {
        // Somebody's worker died holding these rows. It is not an error here — the lease did its
        // job — but a row being reclaimed repeatedly is a publisher crashing on it, and nothing
        // else in the system says so.
        logger.warn(
          { workerId, reclaimed: result.reclaimed },
          'reclaimed rows from expired leases',
        );
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
    {
      workerId,
      brokerConnected: broker.current()?.isAlive() === true,
      ...controls.current(),
    },
    'Worker heartbeat',
  );
}, config.WORKER_HEARTBEAT_MS);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  running = false;
  clearInterval(heartbeat);
  controls.stop();
  printReconciler.stop();
  try {
    await publisherLoop;
    await broker.stop();
    await stopPrinting();
    await closeDb();
  } catch (error) {
    logger.error({ err: error, signal }, 'Failed to shut down worker cleanly');
    process.exitCode = 1;
  }
  logger.info({ signal }, 'Worker stopped');
}

/**
 * Redis is soft at shutdown too (ADR 014): a print pipeline that cannot reach it must not make a
 * clean stop look like a failed one. Sequential rather than concurrent, so one failure does not
 * hide the next, and every step logs instead of propagating.
 */
async function stopPrinting(): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    // The worker first: closing it lets an attempt in flight finish and its outcome reach
    // `print_jobs` before the connections that carry it are gone.
    ['print worker', async () => printWorker.close()],
    ['print queue', async () => printQueue.close()],
    ['print queue redis', async () => queueRedis.quit()],
    ['print worker redis', async () => printWorkerRedis.quit()],
  ];

  for (const [step, stop] of steps) {
    try {
      await stop();
    } catch (error) {
      logger.warn({ err: error, step }, 'could not stop the print pipeline cleanly');
    }
  }
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
