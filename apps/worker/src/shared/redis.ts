import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from 'pino';

/**
 * The connection BullMQ's `Worker` blocks on. `maxRetriesPerRequest: null` is BullMQ's own
 * requirement — a blocking `BZPOPMIN` must not be cancelled by a per-request retry limit — and it
 * is harmless here: nothing awaits this connection on a path that has to finish.
 */
export const BLOCKING_CONNECTION: RedisOptions = {
  lazyConnect: false,
  maxRetriesPerRequest: null,
};

/**
 * The connection the **producer** uses, and the opposite case in every respect. Review round 1
 * found this: `queue.add()` is awaited by the kitchen consumer inside `eachMessage`, so a command
 * that never settles is a consumer that never commits its offset and never projects another order.
 * With `maxRetriesPerRequest: null` on this connection, an unreachable Redis stops the kitchen —
 * which is exactly the claim ADR 014 makes and exactly when it is being tested.
 *
 * So the producer is bounded twice over. `commandTimeout` is the real bound: ioredis starts it when
 * the command is issued, including while the command is sitting in the offline queue waiting for a
 * connection that is not coming. `maxRetriesPerRequest` is the backstop for a connection that keeps
 * flapping rather than staying down.
 *
 * The cost is a command that can be abandoned while still in flight — ioredis rejects the promise
 * without unsending it — so an enqueue reported as failed may still have landed. That is already
 * the safe direction here: the `jobId` is the ticket hash, so a duplicate `add` is a no-op, and a
 * genuinely lost enqueue is what the sweep repairs.
 */
export function producerConnection(commandTimeoutMs: number): RedisOptions {
  return {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    commandTimeout: commandTimeoutMs,
  };
}

/**
 * The `error` listener is not optional. ioredis emits connection failures as events, and an `error`
 * event with no listener is thrown — which would kill the worker, and with it the outbox publisher,
 * over a dependency that is deliberately soft (ADR 011, ADR 014).
 */
export function connectRedis(
  url: string,
  options: RedisOptions,
  role: string,
  logger: Logger,
): Redis {
  const redis = new Redis(url, options);
  redis.on('error', (error: unknown) => {
    logger.warn({ err: error, role }, 'redis connection error');
  });
  return redis;
}

/**
 * Waits for a freshly opened client to report `ready`, and rejects when it has not within the
 * bound.
 *
 * This is for **short-lived** callers — the `printer` CLI — and deliberately not for the worker.
 * A long-running process opens its connection at boot and can refuse an enqueue outright while the
 * client is not ready, because by the time an event arrives it will be (and refusing keeps the
 * consumer at full speed through an outage). A command-line tool has no such head start: it
 * connects and enqueues microseconds apart, so refusing on status would fail against a perfectly
 * healthy Redis. Review round 3 found `printer retry` doing exactly that.
 */
export async function waitUntilReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === 'ready') {
    return;
  }

  let onReady: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      onReady = resolve;
      redis.once('ready', resolve);
      timer = setTimeout(() => {
        reject(new Error(`Redis did not become reachable within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    if (onReady !== undefined) {
      redis.removeListener('ready', onReady);
    }
  }
}
