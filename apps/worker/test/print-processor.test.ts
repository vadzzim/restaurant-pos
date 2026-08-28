import { randomUUID } from 'node:crypto';

import type { PrintTicketResponse } from '@pos/contracts';
import { printJobs } from '@pos/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { processPrintJob, resetDeadLetteredJob } from '../src/modules/printing/print-processor.js';
import type { Printer } from '../src/modules/printing/printer-client.js';
import { ticketHash, type PrintableTicket } from '../src/modules/printing/ticket-hash.js';
import { db, useTestDatabase } from './helpers.js';

useTestDatabase();

const MAX_ATTEMPTS = 3;

function ticket(): PrintableTicket {
  return {
    orderId: randomUUID(),
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    items: [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }],
  };
}

interface FakeDevice extends Printer {
  keys: string[];
  fail: (message?: string) => void;
  fix: () => void;
}

/** A device that can be told to fail, and that remembers every key it was asked to print. */
function fakeDevice(): FakeDevice {
  const keys: string[] = [];
  let failure: string | undefined;

  return {
    keys,
    fail: (message = 'printer answered 503') => {
      failure = message;
    },
    fix: () => {
      failure = undefined;
    },
    print: async (_ticket, idempotencyKey): Promise<PrintTicketResponse> => {
      if (failure !== undefined) {
        throw new Error(failure);
      }
      const duplicate = keys.includes(idempotencyKey);
      keys.push(idempotencyKey);
      return { receiptId: randomUUID(), printed: !duplicate, duplicate };
    },
  };
}

async function job(hash: string) {
  const [row] = await db().select().from(printJobs).where(eq(printJobs.ticketHash, hash)).limit(1);
  return row;
}

describe('the print processor', () => {
  it('records the job and marks it printed', async () => {
    const device = fakeDevice();
    const printable = ticket();

    expect(await processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS })).toBe(
      'printed',
    );

    const row = await job(ticketHash(printable));
    expect(row?.state).toBe('PRINTED');
    expect(row?.attemptCount).toBe(1);
    expect(row?.printedAt).not.toBeNull();
    expect(row?.lastError).toBeNull();
    expect(device.keys).toEqual([ticketHash(printable)]);
  });

  it('does not print a second time for a record that is already PRINTED', async () => {
    const device = fakeDevice();
    const printable = ticket();

    await processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS });
    // The queue can hand the same ticket back — a sweep, a stalled job, a manual add. The record,
    // not the device, is what stops it here: `ticket_hash` deduplicating the row (§12.3).
    expect(await processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS })).toBe(
      'already-printed',
    );

    expect(device.keys).toHaveLength(1);
  });

  it('counts an attempt, keeps the error and rethrows so BullMQ retries', async () => {
    const device = fakeDevice();
    device.fail('printer answered 503: PRINTER_OFFLINE');
    const printable = ticket();

    await expect(
      processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS }),
    ).rejects.toThrow('PRINTER_OFFLINE');

    const row = await job(ticketHash(printable));
    expect(row?.state).toBe('FAILED');
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastError).toContain('PRINTER_OFFLINE');
    expect(row?.printedAt).toBeNull();
  });

  it('dead-letters on the attempt that reaches the ceiling, and prints nothing afterwards', async () => {
    const device = fakeDevice();
    device.fail();
    const printable = ticket();
    const hash = ticketHash(printable);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await expect(
        processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS }),
      ).rejects.toThrow();
      const row = await job(hash);
      expect(row?.attemptCount).toBe(attempt);
      expect(row?.state).toBe(attempt === MAX_ATTEMPTS ? 'DEAD_LETTER' : 'FAILED');
    }

    // A stray retry — a job BullMQ still held, a sweep that raced the last attempt — must not
    // resurrect a dead letter, even once the printer is working again.
    device.fix();
    expect(await processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS })).toBe(
      'dead-lettered',
    );
    expect(device.keys).toHaveLength(0);
  });

  it('reports the device having deduplicated without moving the record backwards', async () => {
    const device = fakeDevice();
    const printable = ticket();
    const hash = ticketHash(printable);

    // The device has seen this key but our record does not say so: the paper came out and the
    // worker died before writing `PRINTED`. That is the §12.3 window, from the other side.
    await device.print(printable, hash);

    expect(await processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS })).toBe(
      'device-duplicate',
    );
    expect((await job(hash))?.state).toBe('PRINTED');
  });
});

describe('resetting a dead-lettered job', () => {
  it('clears the counter so the retry does not dead-letter on its first failure', async () => {
    const device = fakeDevice();
    device.fail();
    const printable = ticket();
    const hash = ticketHash(printable);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await expect(
        processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS }),
      ).rejects.toThrow();
    }

    expect(await resetDeadLetteredJob(db(), printable.orderId)).toBe(hash);

    const row = await job(hash);
    expect(row?.state).toBe('PENDING');
    expect(row?.attemptCount).toBe(0);
    expect(row?.lastError).toBeNull();

    device.fix();
    expect(await processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS })).toBe(
      'printed',
    );
  });

  it('leaves a job that is not dead-lettered alone', async () => {
    const device = fakeDevice();
    const printable = ticket();
    await processPrintJob(db(), device, printable, { maxAttempts: MAX_ATTEMPTS });

    expect(await resetDeadLetteredJob(db(), printable.orderId)).toBeUndefined();
    expect((await job(ticketHash(printable)))?.state).toBe('PRINTED');
  });
});

describe('the ticket hash', () => {
  it('ignores item order and the fields that do not reach the paper', async () => {
    const first: PrintableTicket = {
      orderId: 'a3f0c1d2-0000-4000-8000-000000000001',
      restaurantId: 'demo-restaurant',
      tableNumber: '7',
      items: [
        { productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 },
        { productId: 'cola', name: 'Cola', quantity: 2, unitPriceCents: 300 },
      ],
    };
    const reordered: PrintableTicket = { ...first, items: [...first.items].reverse() };

    expect(ticketHash(reordered)).toBe(ticketHash(first));
    expect(ticketHash({ ...first, tableNumber: '8' })).not.toBe(ticketHash(first));
    expect(
      ticketHash({
        ...first,
        items: [{ ...first.items[0]!, quantity: 2 }, first.items[1]!],
      }),
    ).not.toBe(ticketHash(first));
  });
});
