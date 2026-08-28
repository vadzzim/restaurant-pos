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
 * Resolves only after the first read, so a worker never runs a pass against a guess.
 */
export async function watchOutboxControls(
  db: Db,
  intervalMs: number,
  logger: Logger,
): Promise<OutboxControlWatcher> {
  let value = await readOutboxControls(db);
  logger.info({ ...value }, 'outbox controls loaded');

  const timer = setInterval(() => {
    void readOutboxControls(db)
      .then((fresh) => {
        if (fresh.paused !== value.paused || fresh.publishDelayMs !== value.publishDelayMs) {
          logger.warn({ from: value, to: fresh }, 'outbox controls changed');
          value = fresh;
        }
      })
      .catch((error: unknown) => {
        logger.warn({ err: error, keeping: value }, 'outbox controls unreadable; keeping the last');
      });
  }, intervalMs);

  // Nothing should hold the process open for a switch nobody is waiting on.
  timer.unref?.();

  return {
    current: () => value,
    stop: () => {
      clearInterval(timer);
    },
  };
}
