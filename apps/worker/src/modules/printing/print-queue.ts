import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { settleWithin } from '../../shared/timeout.js';
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
  /** The bound on one `enqueue`, and the reason it can be called from a consumer at all. */
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
 *
 * Takes the ioredis client rather than BullMQ's `ConnectionOptions` because `enqueue` needs to know
 * whether it is connected before it starts anything — see below.
 */
export function createPrintQueue(connection: Redis, options: PrintQueueOptions): PrintQueue {
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
      await enqueueWithin(queue, connection, ticket, options.enqueueTimeoutMs);
    },
    close: async () => {
      await queue.close();
    },
  };
}

/**
 * What makes "best effort" true, in three parts, because a Redis outage can stall an enqueue in
 * three different places and no single guard reaches all of them. The kitchen consumer awaits this
 * inside `eachMessage`, so an enqueue that never settles is a consumer that never commits an offset
 * and never projects another order — the soft dependency taking down the hard path (ADR 014).
 *
 * 1. **Refuse before starting an `add` at all while the client is not ready** — the part review
 *    round 2 added. Waiting *inside* `add` is what retains the job: BullMQ holds the ticket and its
 *    promise against a readiness that is not coming, once per event, for as long as the outage
 *    lasts, and timing the caller out releases none of it. Refusing early also keeps the consumer
 *    at full speed through an outage instead of spending the whole bound on every event. The cost
 *    is a ticket enqueued in the moment between the client opening and reaching `ready` — the
 *    connection is built at boot, long before the consumer group has joined, and the sweep repairs
 *    it if that window is ever hit.
 * 2. **`commandTimeout` on the connection** (`shared/redis.ts`) bounds an `add` that *was* started:
 *    once the client has been ready, a later outage leaves the command in ioredis's offline queue,
 *    where the timeout rejects it.
 * 3. **The race below** covers the seam between the two — the client is ready when it is checked
 *    and drops before `add` reads it, leaving BullMQ inside `waitUntilReady` with no command to
 *    time out. That window is narrow and this is the only thing that closes it.
 *
 * None of the three gives up on the *connection*: it keeps reconnecting, so the queue works again
 * when Redis comes back. And an abandoned `add` is not a cancelled one — it may still land, which
 * is harmless, because the `jobId` is the ticket hash and a genuine loss is the sweep's to repair.
 */
async function enqueueWithin(
  queue: Queue<PrintableTicket>,
  connection: Redis,
  ticket: PrintableTicket,
  timeoutMs: number,
): Promise<void> {
  if (connection.status !== 'ready') {
    throw new Error(
      `the print queue is not connected to Redis (${connection.status}): the ticket for order ` +
        `${ticket.orderId} was not enqueued`,
    );
  }

  const added = await settleWithin(
    queue.add('print-ticket', ticket, { jobId: ticketHash(ticket) }),
    timeoutMs,
  );

  if (added.kind === 'overran') {
    throw new Error(
      `the print queue did not accept the ticket for order ${ticket.orderId} within ${timeoutMs}ms`,
    );
  }

  if (added.kind === 'rejected') {
    throw added.error instanceof Error ? added.error : new Error(String(added.error));
  }
}
