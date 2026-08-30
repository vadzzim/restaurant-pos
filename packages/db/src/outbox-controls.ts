import { eq, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { outboxControls } from './schema.js';

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

/**
 * Lives in `@pos/db` rather than in either application, for the reason written on
 * `printer-controls.ts`: the worker obeys the switch, the API's `/debug` simulator now writes it,
 * and neither owns "one row, id `singleton`, a missing row means the defaults". Moved here in M12,
 * when the second writer appeared. `watchOutboxControls` stayed in the worker — that is the
 * publisher's polling loop, not a shared fact.
 */
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
 * Upserts the singleton. Callers patch one switch at a time — the command-line tool and the
 * `/debug` buttons both set `paused` without knowing the current delay — so an absent field must
 * not overwrite the other switch with a default.
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
