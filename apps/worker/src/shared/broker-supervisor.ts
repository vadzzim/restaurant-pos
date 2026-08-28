import type { Logger } from 'pino';

/** One live connection to the broker, and the promise that tells the supervisor it has ended. */
export interface BrokerSession<T> {
  value: T;
  /**
   * Resolves when this session can no longer do its job and must be rebuilt. `stop()` must resolve
   * it too, so that shutting down does not leave the loop waiting for a death that never comes.
   */
  whenDead: Promise<void>;
  stop: () => Promise<void>;
}

export interface Supervised<T> {
  /** The live session's value, or `undefined` while the broker is unreachable. */
  current: () => T | undefined;
  stop: () => Promise<void>;
}

export interface SuperviseOptions<T> {
  name: string;
  connect: () => Promise<BrokerSession<T>>;
  retryMs: number;
  logger: Logger;
}

/**
 * Keeps a broker connection alive across outages instead of exiting on the first failure.
 *
 * The API supervises its consumer because the API has other work to do without a broker. The
 * worker's case is different and sharper: **the publisher's failure path is not free.** Every
 * failed pass increments `attempt_count`, and an outage lasting past `OUTBOX_MAX_ATTEMPTS` would
 * dead-letter events that were never bad — destroying the meaning of the dead-letter state that
 * M9 and §18 are built on. So the worker stays alive, retries here, and **does not run the
 * publisher while `current()` is undefined**: the backlog waits untouched and drains on recovery.
 *
 * This is deliberately not shared with `superviseRealtimeConsumer` in the API. The two loops look
 * alike, but they live in different processes with different logger types and different reasons to
 * exist; their only shared home would be a new runtime package, which is more structure than forty
 * lines of loop is worth. See ADR 011.
 */
export function supervise<T>({
  name,
  connect,
  retryMs,
  logger,
}: SuperviseOptions<T>): Supervised<T> {
  let wanted = true;
  let session: BrokerSession<T> | undefined;
  /** Cuts the wait between attempts short so shutdown is not held up by a backoff. */
  let wakeFromBackoff: (() => void) | undefined;

  const loop = (async () => {
    while (wanted) {
      try {
        const fresh = await connect();

        // `stop()` can land while a connection is still being made; the session it could not see
        // has to be closed here or it leaks for the life of the process.
        if (!wanted) {
          await fresh.stop().catch(() => undefined);
          return;
        }

        session = fresh;
        logger.info({ dependency: name }, 'broker connected');

        await fresh.whenDead;
        await fresh.stop().catch(() => undefined);
        session = undefined;

        if (!wanted) {
          return;
        }
        logger.warn({ dependency: name }, 'broker connection ended; reconnecting');
      } catch (error) {
        logger.warn(
          { err: error, dependency: name, retryInMs: retryMs },
          'broker unreachable; the outbox keeps its backlog and no publish attempt is spent',
        );
        session = undefined;
      }

      if (wanted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryMs);
          wakeFromBackoff = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wakeFromBackoff = undefined;
      }
    }
  })();

  return {
    current: () => session?.value,
    stop: async () => {
      wanted = false;
      await session?.stop().catch(() => undefined);
      wakeFromBackoff?.();
      await loop;
    },
  };
}
