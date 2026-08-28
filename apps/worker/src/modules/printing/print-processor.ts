import { randomUUID } from 'node:crypto';

import type { PrintJobState } from '@pos/contracts';
import { printJobs, type Db } from '@pos/db';
import { eq, sql } from 'drizzle-orm';

import type { Printer } from './printer-client.js';
import { ticketHash, type PrintableTicket } from './ticket-hash.js';

export interface PrintProcessorOptions {
  /** Attempts, not retries. Reaching it moves the row to `DEAD_LETTER`, which only a human undoes. */
  maxAttempts: number;
}

export type PrintOutcome =
  /** The device emitted a ticket. */
  | 'printed'
  /** The device recognised the idempotency key and emitted nothing. */
  | 'device-duplicate'
  /** Our own record already said `PRINTED`: `ticket_hash` deduplicating the record (§12.3). */
  | 'already-printed'
  /** The row is dead-lettered. A stray retry must not resurrect it. */
  | 'dead-lettered';

/**
 * One attempt at printing one ticket, and the only writer of `print_jobs` (ADR 014).
 *
 * The record is created **here**, on the first attempt, and not when the job was enqueued. That is
 * what gives the reconciliation sweep something unambiguous to look for: a `kitchen_tickets` row
 * with no `print_jobs` row means nothing has ever tried to print it, whatever happened to the job.
 *
 * A failure is recorded and then **rethrown**, because a rejected promise is how a BullMQ processor
 * says "retry this". The two counters — `attempt_count` here and `attemptsMade` in BullMQ — are not
 * kept in step and do not need to be: BullMQ owns the *schedule*, this row owns the *verdict*. A
 * job re-enqueued by the sweep starts a fresh BullMQ attempt series against a row that remembers
 * every attempt before it, so a printer that has been down all afternoon still dead-letters once.
 *
 * What none of this can promise is paper. A device that printed and then failed to answer looks
 * exactly like a device that did not print, and the retry prints again (§12.3).
 */
export async function processPrintJob(
  db: Db,
  printer: Printer,
  ticket: PrintableTicket,
  options: PrintProcessorOptions,
): Promise<PrintOutcome> {
  const hash = ticketHash(ticket);

  const [created] = await db
    .insert(printJobs)
    .values({
      id: randomUUID(),
      orderId: ticket.orderId,
      restaurantId: ticket.restaurantId,
      ticketHash: hash,
      state: 'PENDING' satisfies PrintJobState,
    })
    .onConflictDoNothing({ target: printJobs.ticketHash })
    .returning();

  const row = created ?? (await readJob(db, hash));

  if (row === undefined) {
    // Unreachable: the insert either created the row or lost the race to one that exists.
    throw new Error(`print job vanished for ticket ${hash}`);
  }

  if (row.state === 'PRINTED') {
    return 'already-printed';
  }

  if (row.state === 'DEAD_LETTER') {
    return 'dead-lettered';
  }

  const attempt = row.attemptCount + 1;

  let response;
  try {
    response = await printer.print(ticket, hash);
  } catch (error) {
    await recordFailure(db, hash, attempt, error, options);
    throw error;
  }

  await db
    .update(printJobs)
    .set({
      state: 'PRINTED' satisfies PrintJobState,
      attemptCount: attempt,
      lastError: null,
      printedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(printJobs.ticketHash, hash));

  return response.printed ? 'printed' : 'device-duplicate';
}

async function readJob(db: Db, hash: string): Promise<typeof printJobs.$inferSelect | undefined> {
  const [row] = await db.select().from(printJobs).where(eq(printJobs.ticketHash, hash)).limit(1);
  return row;
}

async function recordFailure(
  db: Db,
  hash: string,
  attempt: number,
  error: unknown,
  options: PrintProcessorOptions,
): Promise<void> {
  const deadLettered = attempt >= options.maxAttempts;

  await db
    .update(printJobs)
    .set({
      state: (deadLettered ? 'DEAD_LETTER' : 'FAILED') satisfies PrintJobState,
      attemptCount: attempt,
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: sql`now()`,
    })
    .where(eq(printJobs.ticketHash, hash));
}

/**
 * Moves a dead-lettered ticket back to `PENDING` so it can be enqueued again (§19.9). The counter
 * is reset with it: a human deciding to retry is a statement that the printer is fixed, and
 * leaving `attempt_count` at its ceiling would dead-letter the job again on its first failure.
 *
 * Guarded on the state, so retrying a ticket that is already printing does not restart its count.
 * Returns the ticket hash when a row was reset, and `undefined` when there was nothing to reset.
 */
export async function resetDeadLetteredJob(db: Db, orderId: string): Promise<string | undefined> {
  const [reset] = await db
    .update(printJobs)
    .set({
      state: 'PENDING' satisfies PrintJobState,
      attemptCount: 0,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(sql`${printJobs.orderId} = ${orderId} and ${printJobs.state} = 'DEAD_LETTER'`)
    .returning({ ticketHash: printJobs.ticketHash });

  return reset?.ticketHash;
}
