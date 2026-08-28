import { randomUUID } from 'node:crypto';

import type { KitchenTicketState, PrintJobState } from '@pos/contracts';
import { kitchenTickets, printJobs } from '@pos/db';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import type { PrintQueue } from '../src/modules/printing/print-queue.js';
import { reconcilePrintJobs, retryDeadLetteredTicket } from '../src/modules/printing/reconcile.js';
import { ticketHash, type PrintableTicket } from '../src/modules/printing/ticket-hash.js';
import { db, useTestDatabase } from './helpers.js';

useTestDatabase();

const logger = pino({ level: 'silent' });
const OPTIONS = { staleAfterMs: 60_000, limit: 50 };
const items = [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }];

interface FakeQueue extends PrintQueue {
  enqueued: PrintableTicket[];
}

function fakeQueue(failure?: Error): FakeQueue {
  const enqueued: PrintableTicket[] = [];
  return {
    enqueued,
    enqueue: async (ticket) => {
      if (failure !== undefined) {
        throw failure;
      }
      enqueued.push(ticket);
    },
    close: async () => undefined,
  };
}

async function insertTicket(state: KitchenTicketState = 'SENT_TO_KITCHEN'): Promise<string> {
  const orderId = randomUUID();
  await db().insert(kitchenTickets).values({
    orderId,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    items,
    state,
    sourceEventVersion: 3,
  });
  return orderId;
}

/** `ageMs` back-dates `updated_at`, which is the only thing that makes a row stale. */
async function insertJob(orderId: string, state: PrintJobState, ageMs = 0): Promise<void> {
  await db()
    .insert(printJobs)
    .values({
      id: randomUUID(),
      orderId,
      restaurantId: 'demo-restaurant',
      ticketHash: ticketHash({
        orderId,
        restaurantId: 'demo-restaurant',
        tableNumber: '12',
        items,
      }),
      state,
    });

  if (ageMs > 0) {
    await db()
      .update(printJobs)
      .set({ updatedAt: sql`now() - ${`${ageMs} milliseconds`}::interval` })
      .where(eq(printJobs.orderId, orderId));
  }
}

describe('the print reconciliation sweep', () => {
  it('enqueues a ticket that has no print job at all', async () => {
    const orderId = await insertTicket();
    const queue = fakeQueue();

    const result = await reconcilePrintJobs(db(), queue, OPTIONS, logger);

    expect(result).toEqual({ found: 1, enqueued: 1 });
    expect(queue.enqueued[0]?.orderId).toBe(orderId);
    // The hash the sweep produces has to match the one the live path produced, or the repair
    // would create a second record for the same paper.
    expect(queue.enqueued[0]?.items).toEqual(items);
  });

  it('leaves a printed ticket, a dead letter, and a job that is merely working', async () => {
    await insertJob(await insertTicket(), 'PRINTED');
    await insertJob(await insertTicket(), 'DEAD_LETTER');
    // Failed, but touched a moment ago: BullMQ is holding its backoff and the sweep must not
    // enqueue a second job for a retry that is already scheduled.
    await insertJob(await insertTicket(), 'FAILED');
    await insertJob(await insertTicket(), 'PENDING');

    const queue = fakeQueue();
    const result = await reconcilePrintJobs(db(), queue, OPTIONS, logger);

    expect(result).toEqual({ found: 0, enqueued: 0 });
  });

  it('re-enqueues a PENDING or FAILED row whose job has gone quiet', async () => {
    const stalePending = await insertTicket();
    await insertJob(stalePending, 'PENDING', 120_000);
    const staleFailed = await insertTicket();
    await insertJob(staleFailed, 'FAILED', 120_000);

    const queue = fakeQueue();
    await reconcilePrintJobs(db(), queue, OPTIONS, logger);

    expect(queue.enqueued.map((ticket) => ticket.orderId).sort()).toEqual(
      [stalePending, staleFailed].sort(),
    );
  });

  it('skips a cancelled ticket, because nobody wants that paper now', async () => {
    await insertTicket('CANCELLED');

    const queue = fakeQueue();
    expect(await reconcilePrintJobs(db(), queue, OPTIONS, logger)).toEqual({
      found: 0,
      enqueued: 0,
    });
  });

  it('stops the pass when the queue is unreachable, and finds the same tickets next time', async () => {
    await insertTicket();
    await insertTicket();

    const broken = fakeQueue(new Error('redis is down'));
    expect(await reconcilePrintJobs(db(), broken, OPTIONS, logger)).toEqual({
      found: 2,
      enqueued: 0,
    });

    const working = fakeQueue();
    expect(await reconcilePrintJobs(db(), working, OPTIONS, logger)).toEqual({
      found: 2,
      enqueued: 2,
    });
  });
});

describe('the manual retry', () => {
  it('resets a dead letter and puts the ticket back on the queue', async () => {
    const orderId = await insertTicket();
    await insertJob(orderId, 'DEAD_LETTER');

    const queue = fakeQueue();
    expect(await retryDeadLetteredTicket(db(), queue, orderId)).toBe('requeued');
    expect(queue.enqueued[0]?.orderId).toBe(orderId);

    const [row] = await db().select().from(printJobs).where(eq(printJobs.orderId, orderId));
    expect(row?.state).toBe('PENDING');
  });

  it('changes nothing for an order that is not dead-lettered', async () => {
    const orderId = await insertTicket();
    await insertJob(orderId, 'FAILED');

    const queue = fakeQueue();
    expect(await retryDeadLetteredTicket(db(), queue, orderId)).toBe('not-dead-lettered');
    expect(queue.enqueued).toHaveLength(0);
    const [row] = await db().select().from(printJobs).where(eq(printJobs.orderId, orderId));
    expect(row?.state).toBe('FAILED');
  });
});
