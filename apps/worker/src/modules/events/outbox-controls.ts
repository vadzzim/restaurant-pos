import { outboxControls, type Db } from '@pos/db';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

/**
 * The publisher is fleet-wide, so its switches are too: one row, one id. A per-restaurant pause
 * would be a different feature — it would have to pause the *claim query*, not the loop — and
 * nothing in §18 asks for it.
 */
const SINGLETON = 'singleton';

/** The two §18 switches, as the publisher sees them. */
export interface OutboxControls {
  /** `Pause Outbox Publisher`: claim nothing, publish nothing, hold no lease. */
  paused: boolean;
  /** `Delay Outbox Publishing`: an artificial wait before each send, so a demo can watch the
   * backlog sit in the table. Milliseconds. */
  publishDelayMs: number;
}

export const DEFAULT_OUTBOX_CONTROLS: OutboxControls = { paused: false, publishDelayMs: 0 };

export interface OutboxControlWatcher {
  /** The last successfully read value. Synchronous, so the publish loop can consult it per row. */
  current: () => OutboxControls;
  stop: () => void;
}

export async function readOutboxControls(db: Db): Promise<OutboxControls> {
  const [row] = await db
    .select()
    .from(outboxControls)
    .where(eq(outboxControls.id, SINGLETON))
    .limit(1);

  if (row === undefined) {
    return DEFAULT_OUTBOX_CONTROLS;
  }

  return { paused: row.paused, publishDelayMs: row.publishDelayMs };
}

/**
 * Upserts the singleton. Callers patch one switch at a time — the command-line tool sets `paused`
 * without knowing the current delay — so an absent field must not overwrite the other switch with
 * a default.
 */
export async function setOutboxControls(db: Db, patch: Partial<OutboxControls>): Promise<void> {
  const merged = { ...DEFAULT_OUTBOX_CONTROLS, ...patch };

  await db
    .insert(outboxControls)
    .values({ id: SINGLETON, paused: merged.paused, publishDelayMs: merged.publishDelayMs })
    .onConflictDoUpdate({
      target: outboxControls.id,
      set: {
        ...(patch.paused === undefined ? {} : { paused: patch.paused }),
        ...(patch.publishDelayMs === undefined ? {} : { publishDelayMs: patch.publishDelayMs }),
        updatedAt: sql`now()`,
      },
    });
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
