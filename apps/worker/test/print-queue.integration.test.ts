import { randomUUID } from 'node:crypto';

import { loadConfig } from '@pos/config';
import type { PrintTicketResponse } from '@pos/contracts';
import { printJobs } from '@pos/db';
import type { Redis, RedisOptions } from 'ioredis';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';

import { createPrintQueue } from '../src/modules/printing/print-queue.js';
import { startPrintWorker } from '../src/modules/printing/print-worker.js';
import type { Printer } from '../src/modules/printing/printer-client.js';
import { ticketHash, type PrintableTicket } from '../src/modules/printing/ticket-hash.js';
import { BLOCKING_CONNECTION, connectRedis, producerConnection } from '../src/shared/redis.js';
import { db, useTestDatabase } from './helpers.js';

useTestDatabase();

const config = loadConfig();
const logger = pino({ level: 'silent' });

/**
 * The BullMQ wiring against a real Redis. Everything else about printing is tested with a fake
 * queue, which proves the rules and proves nothing about the library — and the library is the one
 * thing this milestone brought in. Without this test the only evidence that the queue works would
 * be that it compiles.
 *
 * The queue name carries a uuid so a leftover job from an earlier run can never be picked up here,
 * and the queue is obliterated afterwards rather than left in Redis for the demo to trip over.
 */
const connections: Redis[] = [];

/** The production shapes, so the round trip exercises the options the worker actually runs with. */
function connect(options: RedisOptions): Redis {
  const redis = connectRedis(config.REDIS_URL, options, 'test', logger);
  connections.push(redis);
  return redis;
}

const producerOptions = producerConnection(config.PRINT_ENQUEUE_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(connections.map(async (redis) => redis.quit()));
});

function ticket(): PrintableTicket {
  return {
    orderId: randomUUID(),
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    items: [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }],
  };
}

async function waitForState(hash: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db().select().from(printJobs);
    if (row?.ticketHash === hash && row.state === state) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the print job never reached ${state}`);
}

describe('the print queue against a real Redis', () => {
  it('prints once when the same ticket is enqueued twice', async () => {
    const queueName = `print-test-${randomUUID()}`;
    const printable = ticket();
    const hash = ticketHash(printable);
    const keys: string[] = [];

    const printer: Printer = {
      print: async (_ticket, idempotencyKey): Promise<PrintTicketResponse> => {
        keys.push(idempotencyKey);
        return { receiptId: randomUUID(), printed: true, duplicate: false };
      },
    };

    const queue = createPrintQueue(connect(producerOptions), {
      queueName,
      maxAttempts: 3,
      backoffBaseMs: 100,
      enqueueTimeoutMs: config.PRINT_ENQUEUE_TIMEOUT_MS,
    });
    const worker = startPrintWorker(connect(BLOCKING_CONNECTION), db(), printer, logger, {
      queueName,
      maxAttempts: 3,
    });

    try {
      await queue.enqueue(printable);
      await queue.enqueue(printable);

      await waitForState(hash, 'PRINTED');
      // Long enough for a second job, had one been created, to have run and printed.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Two layers had to hold for this: the queue dropped the duplicate `add` under the same
      // `jobId`, and had it not, the `PRINTED` record would have stopped the second attempt.
      expect(keys).toEqual([hash]);
      expect(await db().select().from(printJobs)).toHaveLength(1);
    } finally {
      await worker.close();
      await queue.close();

      // The queue is disposable: nothing outside this test may find its keys afterwards.
      const cleaner = connect(producerOptions);
      const leftovers = await cleaner.keys(`bull:${queueName}:*`);
      if (leftovers.length > 0) {
        await cleaner.del(...leftovers);
      }
    }
  });
});
