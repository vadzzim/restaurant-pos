import type { OrderItemSnapshot } from '@pos/contracts';
import { kitchenTickets, type Db } from '@pos/db';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { resetDeadLetteredJob } from './print-processor.js';
import type { PrintQueue } from './print-queue.js';
import type { PrintableTicket } from './ticket-hash.js';

export interface ReconcileOptions {
  /**
   * How long a `PENDING` or `FAILED` row may sit untouched before its job is presumed gone. It has
   * to exceed the longest backoff a healthy retry can be waiting out, or the sweep re-enqueues
   * jobs that are merely slow.
   */
  staleAfterMs: number;
  /** A bound on one pass, so a database full of unprintable tickets cannot monopolise the loop. */
  limit: number;
}

export interface ReconcileResult {
  /** Tickets the sweep decided nothing is printing. */
  found: number;
  enqueued: number;
}

interface OrphanRow extends Record<string, unknown> {
  order_id: string;
  restaurant_id: string;
  table_number: string;
  items: OrderItemSnapshot[];
}

/**
 * The repair for every way an enqueue can be lost (§12.3).
 *
 * It reads the **projection**, not the queue, which is what makes it a genuine reconciliation
 * rather than a second retry mechanism: `kitchen_tickets` is the record of what should have
 * printed, and it is written in the same transaction as the event that produced it. So a crash
 * between the projection commit and the enqueue, a redelivery that answered `duplicate` and
 * therefore enqueued nothing, and a Redis that lost every job in it all leave the same evidence —
 * a ticket with no `print_jobs` row — and all three are repaired here.
 *
 * Two states are never swept. `PRINTED` is done. `DEAD_LETTER` is a decision a human has to
 * reverse (`printer retry`), because a sweep that re-enqueued dead letters would turn a broken
 * printer into an infinite loop and dead-lettering would mean nothing.
 *
 * A `CANCELLED` ticket is skipped too, and that one is a judgement rather than an invariant: the
 * sweep can run minutes after the fact, and printing the ticket for an order the floor has already
 * cancelled is paper nobody wants. The live path does not make that check — it enqueues the moment
 * the ticket is created — so an order cancelled a second later can still print. At-least-once cuts
 * that way too.
 */
export async function reconcilePrintJobs(
  db: Db,
  queue: PrintQueue,
  options: ReconcileOptions,
  logger: Logger,
): Promise<ReconcileResult> {
  const orphans = await db.execute<OrphanRow>(sql`
    select ticket.order_id, ticket.restaurant_id, ticket.table_number, ticket.items
    from kitchen_tickets ticket
    left join print_jobs job on job.order_id = ticket.order_id
    where ticket.state <> 'CANCELLED'
      and (
        job.order_id is null
        or (
          job.state in ('PENDING', 'FAILED')
          and job.updated_at < now() - ${`${options.staleAfterMs} milliseconds`}::interval
        )
      )
    order by ticket.created_at
    limit ${options.limit}
  `);

  const result: ReconcileResult = { found: orphans.rows.length, enqueued: 0 };

  for (const row of orphans.rows) {
    const ticket: PrintableTicket = {
      orderId: row.order_id,
      restaurantId: row.restaurant_id,
      tableNumber: row.table_number,
      items: row.items,
    };

    try {
      await queue.enqueue(ticket);
      result.enqueued += 1;
    } catch (error) {
      // Redis is down, or the queue is unwritable. Every remaining row would fail the same way, and
      // the evidence the sweep reads is still in the database: the next pass finds them all again.
      logger.warn(
        { err: error, orderId: ticket.orderId, remaining: result.found - result.enqueued },
        'print reconciliation could not enqueue; stopping this pass',
      );
      break;
    }
  }

  if (result.found > 0) {
    logger.info({ ...result }, 'print reconciliation swept unprinted tickets');
  }

  return result;
}

export type ManualRetryResult =
  | 'requeued'
  /** No dead-lettered row for that order: nothing to retry, and nothing was changed. */
  | 'not-dead-lettered'
  /** The row was reset but its ticket is gone, so there is nothing to print. */
  | 'no-ticket';

/**
 * §19.9's last step: a human says the printer is fixed and asks for the ticket again.
 *
 * The database is reset **first**, so a crash between the two steps leaves a `PENDING` row that is
 * immediately stale — which the sweep re-enqueues. The reverse order could enqueue a job that the
 * processor would refuse, seeing a row still marked `DEAD_LETTER`, and the retry would look like it
 * had worked while nothing printed.
 */
export async function retryDeadLetteredTicket(
  db: Db,
  queue: PrintQueue,
  orderId: string,
): Promise<ManualRetryResult> {
  const reset = await resetDeadLetteredJob(db, orderId);
  if (reset === undefined) {
    return 'not-dead-lettered';
  }

  const [ticket] = await db
    .select({
      orderId: kitchenTickets.orderId,
      restaurantId: kitchenTickets.restaurantId,
      tableNumber: kitchenTickets.tableNumber,
      items: kitchenTickets.items,
    })
    .from(kitchenTickets)
    .where(eq(kitchenTickets.orderId, orderId))
    .limit(1);

  if (ticket === undefined) {
    return 'no-ticket';
  }

  await queue.enqueue({ ...ticket, items: ticket.items as OrderItemSnapshot[] });
  return 'requeued';
}

export interface ReconcilerHandle {
  stop: () => void;
}

/**
 * Runs the sweep on an interval, one pass at a time. `setInterval` would start a second pass while
 * the first was still working through its batch — the same mistake M9's review found in the
 * control watcher, and it matters more here because two passes would enqueue the same tickets.
 */
export function startPrintReconciler(
  db: Db,
  queue: PrintQueue,
  intervalMs: number,
  options: ReconcileOptions,
  logger: Logger,
): ReconcilerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleNext = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(pass, intervalMs);
    timer.unref?.();
  };

  function pass(): void {
    void reconcilePrintJobs(db, queue, options, logger)
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'print reconciliation pass failed');
      })
      .finally(scheduleNext);
  }

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
