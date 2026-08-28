import { Queue, type ConnectionOptions } from 'bullmq';

import { ticketHash, type PrintableTicket } from './ticket-hash.js';

/**
 * The queue, as everything that enqueues sees it: the kitchen consumer, the sweep and the CLI. An
 * interface because two of the three are tested without Redis, and because it keeps the BullMQ
 * types out of modules that have no other reason to know about them.
 */
export interface PrintQueue {
  /** Best effort by contract. Every caller logs a failure and leaves the repair to the sweep. */
  enqueue(ticket: PrintableTicket): Promise<void>;
  close(): Promise<void>;
}

export interface PrintQueueOptions {
  queueName: string;
  maxAttempts: number;
  backoffBaseMs: number;
}

/**
 * `jobId` is the ticket hash, so a ticket that is already queued, running or waiting out a backoff
 * absorbs every further `add` for it — which is what makes the sweep safe to run on a short
 * interval against jobs that are simply slow.
 *
 * Both `removeOnComplete` and `removeOnFail` are on, and that is a decision rather than tidiness:
 * BullMQ keeps terminal jobs under their id, and a retained one would silently swallow every later
 * `add` for the same ticket — including the sweep's repair and a human's manual retry. The visible
 * record of a failure is the `print_jobs` row (ADR 014), which is where `/debug` will read it.
 */
export function createPrintQueue(
  connection: ConnectionOptions,
  options: PrintQueueOptions,
): PrintQueue {
  const queue = new Queue<PrintableTicket>(options.queueName, {
    connection,
    defaultJobOptions: {
      attempts: options.maxAttempts,
      backoff: { type: 'exponential', delay: options.backoffBaseMs },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  return {
    enqueue: async (ticket) => {
      await queue.add('print-ticket', ticket, { jobId: ticketHash(ticket) });
    },
    close: async () => {
      await queue.close();
    },
  };
}
