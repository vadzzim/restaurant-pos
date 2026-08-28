import { randomUUID } from 'node:crypto';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createPrintQueue } from '../src/modules/printing/print-queue.js';
import type { PrintableTicket } from '../src/modules/printing/ticket-hash.js';
import { connectRedis, producerConnection } from '../src/shared/redis.js';

const logger = pino({ level: 'silent' });

/**
 * A port nothing listens on, so every connection attempt is refused immediately. That makes this a
 * unit test rather than an integration one: it needs no Redis, only the absence of one.
 */
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

const ENQUEUE_TIMEOUT_MS = 400;

function ticket(): PrintableTicket {
  return {
    orderId: randomUUID(),
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    items: [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }],
  };
}

/**
 * Review round 1's finding, as a test. The kitchen consumer awaits `enqueue` inside `eachMessage`,
 * so an enqueue that never settles stops the consumer committing offsets and stops the kitchen
 * projecting anything further — a soft dependency taking the system down, which is exactly what
 * ADR 014 says Redis must never do.
 *
 * Redis is unreachable here from the start, which is the case the transport's own `commandTimeout`
 * cannot bound: BullMQ is still waiting for the connection to become ready and has issued no
 * command at all.
 */
describe('the print queue with Redis unreachable', () => {
  it('rejects the enqueue within its bound instead of waiting for ever', async () => {
    const redis = connectRedis(
      UNREACHABLE_REDIS,
      producerConnection(ENQUEUE_TIMEOUT_MS),
      'test',
      logger,
    );
    const queue = createPrintQueue(redis, {
      queueName: `print-unreachable-${randomUUID()}`,
      maxAttempts: 3,
      backoffBaseMs: 100,
      enqueueTimeoutMs: ENQUEUE_TIMEOUT_MS,
    });

    try {
      const started = Date.now();

      await expect(queue.enqueue(ticket())).rejects.toThrow(/did not accept the ticket|timeout/i);

      // Generous, because the assertion is "bounded", not "fast": ten times the bound still fails
      // if the enqueue is waiting on a reconnect loop that never ends.
      expect(Date.now() - started).toBeLessThan(ENQUEUE_TIMEOUT_MS * 10);
    } finally {
      // The raw client first: `queue.close()` would otherwise wait on the connection this test
      // exists because nothing can reach.
      redis.disconnect();
      await queue.close().catch(() => undefined);
    }
  });
});
