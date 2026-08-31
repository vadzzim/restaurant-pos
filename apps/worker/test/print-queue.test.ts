import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createPrintQueue, type PrintQueue } from '../src/modules/printing/print-queue.js';
import { startPrintWorker } from '../src/modules/printing/print-worker.js';
import type { Printer } from '../src/modules/printing/printer-client.js';
import type { PrintableTicket } from '../src/modules/printing/ticket-hash.js';
import {
  BLOCKING_CONNECTION,
  connectRedis,
  producerConnection,
  waitUntilReady,
} from '../src/shared/redis.js';
import { db, useTestDatabase } from './helpers.js';

useTestDatabase();

const logger = pino({ level: 'silent' });

/**
 * A port nothing listens on, so every connection attempt is refused immediately: these tests need
 * no Redis, only the absence of one. (They still use the test database, like every other suite
 * here, because `startPrintWorker` takes one — it never reaches it.)
 */
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

const ENQUEUE_TIMEOUT_MS = 300;

let open: { queue: PrintQueue; redis: Redis } | undefined;

function unreachableQueue(): PrintQueue {
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

  open = { queue, redis };
  return queue;
}

afterEach(async () => {
  if (open !== undefined) {
    // The raw client first: `queue.close()` would otherwise wait on the connection these tests
    // exist because nothing can reach — which is the shutdown bug review round 2 found.
    open.redis.disconnect();
    await open.queue.close().catch(() => undefined);
    open = undefined;
  }
});

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
 * Redis is unreachable from the start here, which is the case the connection's own `commandTimeout`
 * cannot bound: BullMQ would still be waiting for the client to become ready, with no command
 * issued at all.
 */
describe('the print queue with Redis unreachable', () => {
  it('rejects the enqueue within its bound instead of waiting for ever', async () => {
    const queue = unreachableQueue();
    const started = Date.now();

    await expect(queue.enqueue(ticket())).rejects.toThrow(/not connected to Redis/);

    // Generous, because the assertion is "bounded", not "fast": ten times the bound still fails if
    // the enqueue is waiting on a reconnect loop that never ends.
    expect(Date.now() - started).toBeLessThan(ENQUEUE_TIMEOUT_MS * 10);
  });

  /**
   * Review round 2's finding. Bounding the *caller* is not the same as releasing the *work*: an
   * `add` started against a client that is not ready is held by BullMQ, with the ticket inside it,
   * until Redis returns — one per event, for the length of the outage.
   *
   * "Nothing is retained" cannot be asserted directly, so this asserts what only holds when nothing
   * is started: every enqueue refuses on the connection's status instead of handing work to BullMQ
   * and waiting out a timeout. Twenty of them inside a single bound is impossible otherwise.
   */
  it('refuses every enqueue outright rather than starting an add for each one', async () => {
    const queue = unreachableQueue();
    const started = Date.now();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(queue.enqueue(ticket())).rejects.toThrow(/not connected to Redis/);
    }

    expect(Date.now() - started).toBeLessThan(ENQUEUE_TIMEOUT_MS);
  });
});

describe('waiting for a Redis that is not there', () => {
  it('gives up within the bound instead of holding a command-line tool open', async () => {
    const redis = connectRedis(
      UNREACHABLE_REDIS,
      producerConnection(ENQUEUE_TIMEOUT_MS),
      'test',
      logger,
    );

    try {
      const started = Date.now();
      await expect(waitUntilReady(redis, ENQUEUE_TIMEOUT_MS)).rejects.toThrow(/did not become/);
      expect(Date.now() - started).toBeLessThan(ENQUEUE_TIMEOUT_MS * 10);
    } finally {
      redis.disconnect();
    }
  });
});

/**
 * BullMQ's `Worker` duplicates the client it is given for its blocking commands, and that duplicate
 * is not reachable from here: if closing the worker did not end it, its reconnect timers would keep
 * the process alive after a deliberate shutdown. Review round 3 raised that; it holds today because
 * `Worker.close()` disconnects the duplicate locally rather than sending it a `QUIT`. This asserts
 * the property rather than the mechanism, because the mechanism is BullMQ's to change.
 */
describe('what the print worker reports about itself', () => {
  /**
   * The Codex review of M24: `worker.isRunning()` is BullMQ's main loop, and that loop keeps
   * running while the blocking client reconnects — so a readiness probe built on it alone answers
   * "printing is fine" through a Redis outage, which is the one failure the healthcheck exists to
   * catch. This connection is refused on every attempt, and `isConsuming()` has to say so.
   */
  it('is not consuming while its Redis is unreachable, however alive BullMQ looks', async () => {
    const redis = connectRedis(UNREACHABLE_REDIS, BLOCKING_CONNECTION, 'test', logger);
    const printer: Printer = {
      print: async () => {
        throw new Error('the device is never reached in this test');
      },
    };
    const worker = startPrintWorker(redis, db(), printer, logger, {
      queueName: `print-consuming-${randomUUID()}`,
      maxAttempts: 3,
    });

    try {
      expect(worker.isConsuming()).toBe(false);
    } finally {
      await worker.close();
      redis.disconnect();
    }
  });
});

describe('closing the print worker with Redis unreachable', () => {
  it('finishes rather than waiting on a connection it cannot reach', async () => {
    const redis = connectRedis(UNREACHABLE_REDIS, BLOCKING_CONNECTION, 'test', logger);
    const printer: Printer = {
      print: async () => {
        throw new Error('the device is never reached in this test');
      },
    };
    const worker = startPrintWorker(redis, db(), printer, logger, {
      queueName: `print-unreachable-${randomUUID()}`,
      maxAttempts: 3,
    });

    const started = Date.now();
    await worker.close();
    redis.disconnect();

    expect(Date.now() - started).toBeLessThan(ENQUEUE_TIMEOUT_MS * 10);
  });
});
