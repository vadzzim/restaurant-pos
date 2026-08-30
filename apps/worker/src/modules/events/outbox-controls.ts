import type { OutboxControls } from '@pos/db';
import type { Logger } from 'pino';

/**
 * The publisher's end of the two §18 outbox switches. The row itself — how it is read, how it is
 * written, what a missing row means — moved to `@pos/db` in M12, when `/debug` became the second
 * writer. What stays here is the only part that is the worker's alone: the loop that keeps a
 * snapshot fresh so the publish loop can consult it per row without a query.
 */

export interface OutboxControlWatcher {
  /** The last successfully read value. Synchronous, so the publish loop can consult it per row. */
  current: () => OutboxControls;
  stop: () => void;
}

/**
 * Polls the singleton so the publish loop can read it without a query per row.
 *
 * **A failed read keeps the last known value.** Reverting to the defaults would silently un-pause a
 * publisher a human paused, at the exact moment the database is unhealthy — the worst time to
 * discover that a switch is not sticky. The publisher cannot do anything without PostgreSQL anyway,
 * so a stale snapshot costs nothing.
 *
 * **One read at a time.** The interval is the gap *between* reads, not a metronome: `setInterval`
 * would start a second read while the first was still outstanding, and during exactly the database
 * degradation this has to survive, those reads would pile onto the pool and could settle out of
 * order — an older snapshot overwriting a newer pause. Review round 1 found that.
 *
 * Takes a reader rather than a `Db` so the loop above can be tested without a database that can be
 * made slow to order.
 *
 * Resolves only after the first read, so a worker never runs a pass against a guess.
 */
export async function watchOutboxControls(
  read: () => Promise<OutboxControls>,
  intervalMs: number,
  logger: Logger,
): Promise<OutboxControlWatcher> {
  let value = await read();
  logger.info({ ...value }, 'outbox controls loaded');

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleNext = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(poll, intervalMs);
    // Nothing should hold the process open for a switch nobody is waiting on.
    timer.unref?.();
  };

  function poll(): void {
    void read()
      .then((fresh) => {
        if (fresh.paused !== value.paused || fresh.publishDelayMs !== value.publishDelayMs) {
          logger.warn({ from: value, to: fresh }, 'outbox controls changed');
          value = fresh;
        }
      })
      .catch((error: unknown) => {
        logger.warn({ err: error, keeping: value }, 'outbox controls unreadable; keeping the last');
      })
      .finally(scheduleNext);
  }

  scheduleNext();

  return {
    current: () => value,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
