import type { Db } from '@pos/db';
import { Worker, type ConnectionOptions } from 'bullmq';
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
   * Whether BullMQ is still consuming. Read by the worker's readiness probe — a process that
   * publishes but has stopped printing is not a healthy worker, and until M24 nothing asked.
   */
  isRunning: () => boolean;
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
  connection: ConnectionOptions,
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
    isRunning: () => worker.isRunning(),
  };
}
