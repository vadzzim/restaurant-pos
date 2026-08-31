import type { Db } from '@pos/db';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { processPrintJob } from './print-processor.js';
import type { Printer } from './printer-client.js';
import type { PrintableTicket } from './ticket-hash.js';

export interface PrintWorkerOptions {
  queueName: string;
  maxAttempts: number;
}

export interface PrintWorkerHandle {
  close: () => Promise<void>;
  /**
   * Whether tickets can actually be taken off the queue. Read by the worker's readiness probe — a
   * process that publishes but has stopped printing is not a healthy worker, and until M24 nothing
   * asked.
   *
   * **Both halves are needed and `isRunning()` alone is not enough.** BullMQ keeps its main loop
   * running while its blocking client reconnects, so `isRunning()` stays true through a Redis
   * outage and readiness would have gone on answering 200 with the print pipeline dead — the whole
   * failure the healthcheck was added for. Found by the Codex review of M24.
   *
   * This is not a retreat from ADR 014's "Redis is soft". Soft means the process keeps running and
   * still shuts down cleanly through an outage; it never meant that an unreachable Redis is a
   * working print pipeline, and readiness is where the difference is reported.
   */
  isConsuming: () => boolean;
}

/**
 * The BullMQ side of §12.3, and the only place in the repository where a queue owns a retry
 * schedule (ADR 010 explains why the outbox does not).
 *
 * `concurrency` is left at BullMQ's default of one: a printer is a single physical device, and two
 * workers racing on the same `print_jobs` row would spend attempts twice as fast for no gain.
 *
 * The `error` handler exists because BullMQ emits connection failures on the worker rather than
 * throwing them. Without a listener Node treats them as unhandled and kills the process — which
 * would take the outbox publisher down with it over a dependency that is deliberately soft
 * (ADR 011, ADR 014).
 */
export function startPrintWorker(
  // A live client rather than BullMQ's `ConnectionOptions` union: both callers pass one, and
  // `isConsuming` below has to be able to ask it whether Redis is reachable.
  connection: Redis,
  db: Db,
  printer: Printer,
  logger: Logger,
  options: PrintWorkerOptions,
): PrintWorkerHandle {
  const worker = new Worker<PrintableTicket>(
    options.queueName,
    async (job) => {
      const outcome = await processPrintJob(db, printer, job.data, {
        maxAttempts: options.maxAttempts,
      });

      logger.info(
        {
          jobId: job.id,
          orderId: job.data.orderId,
          restaurantId: job.data.restaurantId,
          attemptsMade: job.attemptsMade + 1,
          outcome,
        },
        'print job processed',
      );

      return outcome;
    },
    { connection },
  );

  worker.on('failed', (job, error) => {
    logger.warn(
      {
        err: error,
        jobId: job?.id,
        orderId: job?.data.orderId,
        attemptsMade: job?.attemptsMade,
        maxAttempts: options.maxAttempts,
      },
      'print attempt failed',
    );
  });

  worker.on('error', (error) => {
    logger.warn({ err: error }, 'print worker transport error');
  });

  return {
    close: async () => {
      await worker.close();
    },
    // `status` is ioredis's own state machine, and `ready` is the only value that means commands
    // are being served — the API's Redis probe reads the same field (ADR 011). BullMQ duplicates
    // this client for its blocking commands, so what is asked here is "is that server reachable",
    // which is the question, rather than "is that exact socket the one blocking on BZPOPMIN".
    isConsuming: () => worker.isRunning() && connection.status === 'ready',
  };
}
