import type {
  ConflictsDebugResponse,
  EventsDebugResponse,
  MetricsResponse,
  OutboxDebugResponse,
} from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { validationFailed } from '../../../shared/errors.js';
import {
  readConflicts,
  readDatabaseCounters,
  readOutboxRows,
  readPrintJobs,
  readRecentEvents,
} from '../application/debug-queries.js';
import { collectMetrics } from '../application/metrics.js';
import type { PresenceStore, SharedCounterStore, SocketGauge } from '../application/ports.js';

export interface DebugRouteOptions {
  db: Db;
  /** The default page size; a request may ask for less, never for more (`DEBUG_ROW_LIMIT`). */
  rowLimit: number;
  socketGauge?: SocketGauge | undefined;
  presence?: PresenceStore | undefined;
  sharedCounters?: SharedCounterStore | undefined;
}

/**
 * Four of §17's five debug endpoints. The fifth, `/api/debug/dependencies`, stays in
 * `modules/health`: it is the third leg of the health split (ADR 011) and was built there in M6.
 *
 * What each endpoint owns is decided once, here, so that the page never has to ask "which of these
 * five do I call for that number":
 *
 * - `events` — the **stream** view. What happened, newest first, and who has consumed it.
 * - `conflicts` — conflict history (§8): versions, `mutationId`, resolution.
 * - `outbox` — the **delivery** view. What is stuck: outbox rows *and* print jobs, because both
 *   are at-least-once pipelines with attempts, a last error and a dead-letter state, and the
 *   question a human asks of them is the same one.
 * - `metrics` — every §20 counter plus terminal presence: the two things that are gauges rather
 *   than stored records.
 *
 * `events` and `outbox` both read `outbox_events` on purpose. One asks *what happened*; the other
 * asks *what is stuck*. Merging them would give a page that is either a log with retry columns or
 * a queue with a history nobody wanted.
 *
 * All four are read-only. §18's controls are M12's and the flag toggles are M13's; this milestone
 * builds the numbers and not a single button.
 */
export function registerDebugRoutes(app: FastifyInstance, options: DebugRouteOptions): void {
  const { db, rowLimit } = options;

  const querySchema = z.object({
    limit: z.coerce.number().int().positive().max(rowLimit).optional(),
  });

  function limitOf(query: unknown): number {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) {
      throw validationFailed(
        `limit must be a positive integer of at most ${rowLimit}.`,
        parsed.error,
      );
    }
    return parsed.data.limit ?? rowLimit;
  }

  app.get('/api/debug/events', async (request): Promise<EventsDebugResponse> => ({
    events: await readRecentEvents(db, limitOf(request.query)),
  }));

  app.get('/api/debug/conflicts', async (request): Promise<ConflictsDebugResponse> => {
    const [conflicts, counters] = await Promise.all([
      readConflicts(db, limitOf(request.query)),
      readDatabaseCounters(db),
    ]);

    // The totals come from the counter query rather than from `conflicts.length`: the list is a
    // page, and a page of fifty out of four hundred that called itself the total would be the one
    // number on this screen that lies.
    return {
      conflicts,
      total: counters.conflictsDetected,
      unresolved: counters.blockedMutations,
    };
  });

  app.get('/api/debug/outbox', async (request): Promise<OutboxDebugResponse> => {
    const limit = limitOf(request.query);
    const [rows, jobs, counters] = await Promise.all([
      readOutboxRows(db, limit),
      readPrintJobs(db, limit),
      readDatabaseCounters(db),
    ]);

    return {
      outbox: {
        pending: counters.outboxPending,
        published: counters.outboxPublished,
        deadLettered: counters.outboxDeadLettered,
        rows,
      },
      printJobs: {
        pending: counters.printJobsPending,
        printed: counters.printJobsPrinted,
        failed: counters.printJobsFailed,
        deadLettered: counters.printJobsDeadLettered,
        rows: jobs,
      },
    };
  });

  app.get('/api/debug/metrics', async (): Promise<MetricsResponse> =>
    collectMetrics({
      db,
      socketGauge: options.socketGauge,
      presence: options.presence,
      sharedCounters: options.sharedCounters,
    }),
  );
}
