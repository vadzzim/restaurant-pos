import type { DependencyKind, DependencyReport, OutboxBacklog } from '@pos/contracts';
import type { Db } from '@pos/db';
import { sql } from 'drizzle-orm';

/**
 * A dependency the API can reach, and what its absence costs. `impact` is part of the probe rather
 * than a lookup elsewhere because the report is read by a human under pressure: "redis is down"
 * without "cross-instance fan-out degrades, writes are unaffected" is a fact without a decision.
 */
export interface DependencyProbe {
  name: string;
  kind: DependencyKind;
  impact: string;
  check: () => Promise<void>;
}

/** PostgreSQL is the one hard dependency: without it this instance cannot accept a write (§17). */
export function postgresProbe(db: Db): DependencyProbe {
  return {
    name: 'postgres',
    kind: 'hard',
    impact: 'Writes and reads both fail. This instance must not be sent traffic.',
    check: async () => {
      await db.execute(sql`select 1`);
    },
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // No stack traces leave the API (§17), and a driver message can be long enough to bury the
  // report it appears in.
  return message.slice(0, 200);
}

/**
 * One unreachable dependency must not make the report that explains it hang, so every probe races
 * its own timeout. The losing promise is left to settle on its own — a rejection after the race is
 * swallowed deliberately, because an unhandled rejection here would take down the process that is
 * trying to describe the outage.
 */
export async function runProbe(
  probe: DependencyProbe,
  timeoutMs: number,
): Promise<DependencyReport> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    // `race` attaches a handler to both, so a check that rejects after the timeout has already
    // won is still considered handled and cannot become an unhandled rejection.
    await Promise.race([probe.check(), timeout]);
    return {
      name: probe.name,
      kind: probe.kind,
      status: 'up',
      latencyMs: Math.round(performance.now() - started),
      impact: probe.impact,
    };
  } catch (error) {
    return {
      name: probe.name,
      kind: probe.kind,
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: errorMessage(error),
      impact: probe.impact,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface BacklogRow extends Record<string, unknown> {
  pending: string | number;
  dead_lettered: string | number;
  oldest_pending_age_seconds: string | number | null;
}

/**
 * "Redpanda is down" and "and 47 events are waiting" are one thought, so the dependency report
 * carries the backlog. The age of the oldest unpublished row is the number that separates a
 * publisher pausing for a second from one that has not run since lunch.
 */
export async function readOutboxBacklog(db: Db): Promise<OutboxBacklog> {
  const result = await db.execute<BacklogRow>(sql`
    select
      count(*) filter (where published_at is null and dead_lettered_at is null) as pending,
      count(*) filter (where dead_lettered_at is not null) as dead_lettered,
      extract(
        epoch from now() - min(created_at)
          filter (where published_at is null and dead_lettered_at is null)
      ) as oldest_pending_age_seconds
    from outbox_events
  `);

  const row = result.rows[0];
  const age = row?.oldest_pending_age_seconds;

  return {
    pending: Number(row?.pending ?? 0),
    deadLettered: Number(row?.dead_lettered ?? 0),
    oldestPendingAgeSeconds: age === null || age === undefined ? null : Math.round(Number(age)),
  };
}
