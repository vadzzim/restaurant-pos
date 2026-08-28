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
  /** The bound on one `add`, and the reason `enqueue` can be called from a consumer at all. */
  enqueueTimeoutMs: number;
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
      await withinTimeout(
        queue.add('print-ticket', ticket, { jobId: ticketHash(ticket) }),
        options.enqueueTimeoutMs,
        ticket.orderId,
      );
    },
    close: async () => {
      await queue.close();
    },
  };
}

/**
 * The bound that makes "best effort" true, added by review round 1.
 *
 * The kitchen consumer awaits `enqueue` inside `eachMessage`, so an `add` that never settles is a
 * consumer that never commits its offset and never projects another order — a soft dependency
 * taking a hard one down with it, which is precisely the claim ADR 014 makes.
 *
 * Bounding it needs **two** guards, because there are two ways to wait and the transport only
 * covers one of them. Once the connection has been ready, a later outage leaves commands in
 * ioredis's offline queue, where `commandTimeout` rejects them (see `shared/redis.ts`). But if
 * Redis was never reachable, BullMQ's connection is still inside `waitUntilReady` and has issued no
 * command at all — nothing to time out — and it waits for as long as ioredis keeps reconnecting.
 * That is the case this race covers.
 *
 * Giving up here does **not** cancel the `add`, and it deliberately does not poison the queue: the
 * connection keeps reconnecting, so the same queue works again when Redis comes back. A late `add`
 * that lands after we reported failure is harmless — the `jobId` is the ticket hash — and a genuine
 * loss is what the sweep repairs.
 */
async function withinTimeout(
  added: Promise<unknown>,
  timeoutMs: number,
  orderId: string,
): Promise<void> {
  // A rejection is turned into a value up front, so the promise we may abandon always has a
  // handler: an unhandled rejection here would take the whole worker down.
  const settled = added.then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );

  let timer: NodeJS.Timeout | undefined;
  const overran = new Promise<'overran'>((resolve) => {
    timer = setTimeout(() => {
      resolve('overran');
    }, timeoutMs);
  });

  try {
    const outcome = await Promise.race([settled, overran]);

    if (outcome === 'overran') {
      throw new Error(
        `the print queue did not accept the ticket for order ${orderId} within ${timeoutMs}ms`,
      );
    }

    if (!outcome.ok) {
      throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
    }
  } finally {
    clearTimeout(timer);
  }
}
