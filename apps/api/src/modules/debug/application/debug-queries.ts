import type { ConflictView, DebugEventView, OutboxRowView, PrintJobRowView } from '@pos/contracts';
import type { Db } from '@pos/db';
import { sql } from 'drizzle-orm';

/**
 * Every `/debug` read that comes out of PostgreSQL, in one place.
 *
 * Raw `sql` rather than the query builder, by the same convention the rest of this repository
 * follows for anything whose shape matters: these are reporting queries with filtered aggregates
 * and a lateral join, and hiding them behind ORM helpers would make the thing a reviewer has to
 * check — what exactly is being counted — the thing that is hardest to see.
 *
 * The date columns come back as `Date` from `pg` and go out as ISO strings, so the client never
 * has to guess a format.
 */

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function count(value: unknown): number {
  return Number(value ?? 0);
}

/* ----------------------------------------------------------------------------- counters ----- */

export interface DatabaseCounters {
  conflictsDetected: number;
  blockedMutations: number;
  processedMutations: number;
  outboxPending: number;
  outboxPublished: number;
  outboxDeadLettered: number;
  kafkaEventsConsumed: number;
  printJobsPending: number;
  printJobsPrinted: number;
  printJobsFailed: number;
  printJobsDeadLettered: number;
}

interface CounterRow extends Record<string, unknown> {
  conflicts_detected: string;
  blocked_mutations: string;
  processed_mutations: string;
  outbox_pending: string;
  outbox_published: string;
  outbox_dead_lettered: string;
  kafka_events_consumed: string;
  print_pending: string;
  print_printed: string;
  print_failed: string;
  print_dead_lettered: string;
}

/**
 * The durable half of §20, derived rather than counted.
 *
 * Every number here is a fact that already has a row, which is what makes it survive a restart of
 * either process and read the same from any API instance. It is also the answer to the two-process
 * problem: the worker publishes and prints, and none of that has to be shipped anywhere for this
 * query to see it.
 *
 * One query, not eleven, because `/debug` polls: eleven round trips every two seconds against the
 * database that is also serving the POS is a debug page that changes the thing it is measuring.
 */
export async function readDatabaseCounters(db: Db): Promise<DatabaseCounters> {
  const result = await db.execute<CounterRow>(sql`
    select
      (select count(*) from conflict_log) as conflicts_detected,
      (select count(*) from conflict_log where resolution is null) as blocked_mutations,
      (select count(*) from processed_mutations) as processed_mutations,
      (select count(*) from outbox_events
        where published_at is null and dead_lettered_at is null) as outbox_pending,
      (select count(*) from outbox_events where published_at is not null) as outbox_published,
      (select count(*) from outbox_events where dead_lettered_at is not null) as outbox_dead_lettered,
      (select count(*) from processed_events) as kafka_events_consumed,
      (select count(*) from print_jobs where state = 'PENDING') as print_pending,
      (select count(*) from print_jobs where state = 'PRINTED') as print_printed,
      (select count(*) from print_jobs where state = 'FAILED') as print_failed,
      (select count(*) from print_jobs where state = 'DEAD_LETTER') as print_dead_lettered
  `);

  const row = result.rows[0];

  return {
    conflictsDetected: count(row?.conflicts_detected),
    blockedMutations: count(row?.blocked_mutations),
    processedMutations: count(row?.processed_mutations),
    outboxPending: count(row?.outbox_pending),
    outboxPublished: count(row?.outbox_published),
    outboxDeadLettered: count(row?.outbox_dead_lettered),
    kafkaEventsConsumed: count(row?.kafka_events_consumed),
    printJobsPending: count(row?.print_pending),
    printJobsPrinted: count(row?.print_printed),
    printJobsFailed: count(row?.print_failed),
    printJobsDeadLettered: count(row?.print_dead_lettered),
  };
}

/* ------------------------------------------------------------------------------- events ----- */

interface EventRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  aggregate_id: string;
  restaurant_id: string;
  event_version: number;
  created_at: Date;
  published_at: Date | null;
  dead_lettered_at: Date | null;
  trace_id: string | null;
  consumed_by: string[] | null;
}

/**
 * The stream view of §16: what happened, newest first.
 *
 * It reads `outbox_events` because that is the durable record of every domain event — the topic is
 * not queryable and the broker's retention is not ours. `consumed_by` is aggregated from
 * `processed_events` so that "published, but the kitchen consumer has not recorded it" is visible
 * in one row rather than inferred from two panels.
 */
export async function readRecentEvents(db: Db, limit: number): Promise<DebugEventView[]> {
  const result = await db.execute<EventRow>(sql`
    select
      e.id,
      e.event_type,
      e.aggregate_id,
      e.restaurant_id,
      e.event_version,
      e.created_at,
      e.published_at,
      e.dead_lettered_at,
      e.trace_id,
      consumers.names as consumed_by
    from outbox_events e
    left join lateral (
      select array_agg(p.consumer_name order by p.consumer_name) as names
      from processed_events p
      where p.event_id = e.id
    ) consumers on true
    order by e.created_at desc, e.event_version desc
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    eventId: row.id,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    restaurantId: row.restaurant_id,
    version: Number(row.event_version),
    createdAt: iso(row.created_at),
    publishedAt: isoOrNull(row.published_at),
    deadLetteredAt: isoOrNull(row.dead_lettered_at),
    traceId: row.trace_id,
    consumedBy: row.consumed_by ?? [],
  }));
}

/* ---------------------------------------------------------------------------- conflicts ----- */

interface ConflictRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  terminal_id: string;
  mutation_id: string;
  mutation_type: string;
  client_base_version: number;
  server_version: number;
  server_status: ConflictView['serverStatus'];
  resolution: string | null;
  created_at: Date;
}

export async function readConflicts(db: Db, limit: number): Promise<ConflictView[]> {
  const result = await db.execute<ConflictRow>(sql`
    select id, order_id, terminal_id, mutation_id, mutation_type,
           client_base_version, server_version, server_status, resolution, created_at
    from conflict_log
    order by created_at desc
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    terminalId: row.terminal_id,
    mutationId: row.mutation_id,
    mutationType: row.mutation_type,
    clientBaseVersion: Number(row.client_base_version),
    serverVersion: Number(row.server_version),
    serverStatus: row.server_status,
    resolution: row.resolution,
    createdAt: iso(row.created_at),
  }));
}

/* -------------------------------------------------------------------------- the pipeline ---- */

interface OutboxRow extends Record<string, unknown> {
  id: string;
  aggregate_id: string;
  restaurant_id: string;
  event_type: string;
  event_version: number;
  created_at: Date;
  published_at: Date | null;
  dead_lettered_at: Date | null;
  attempt_count: number;
  reclaim_count: number;
  last_error: string | null;
  claimed_by: string | null;
  next_attempt_at: Date;
}

/**
 * The delivery view: what is stuck, and why.
 *
 * Ordered so that the rows a human is looking for come first — dead-lettered, then unpublished,
 * then the recently published — because a `limit` over `created_at desc` alone would bury a row
 * that dead-lettered an hour ago under a hundred healthy ones.
 */
export async function readOutboxRows(db: Db, limit: number): Promise<OutboxRowView[]> {
  const result = await db.execute<OutboxRow>(sql`
    select id, aggregate_id, restaurant_id, event_type, event_version, created_at,
           published_at, dead_lettered_at, attempt_count, reclaim_count, last_error,
           claimed_by, next_attempt_at
    from outbox_events
    order by
      (dead_lettered_at is not null) desc,
      (published_at is null) desc,
      created_at desc
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    aggregateId: row.aggregate_id,
    restaurantId: row.restaurant_id,
    eventType: row.event_type,
    eventVersion: Number(row.event_version),
    createdAt: iso(row.created_at),
    publishedAt: isoOrNull(row.published_at),
    deadLetteredAt: isoOrNull(row.dead_lettered_at),
    attemptCount: Number(row.attempt_count),
    reclaimCount: Number(row.reclaim_count),
    lastError: row.last_error,
    claimedBy: row.claimed_by,
    nextAttemptAt: iso(row.next_attempt_at),
  }));
}

interface PrintJobRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  restaurant_id: string;
  ticket_hash: string;
  state: PrintJobRowView['state'];
  attempt_count: number;
  last_error: string | null;
  printed_at: Date | null;
  updated_at: Date;
}

/** The same ordering rule as the outbox: the dead letters and the failures first. */
export async function readPrintJobs(db: Db, limit: number): Promise<PrintJobRowView[]> {
  const result = await db.execute<PrintJobRow>(sql`
    select id, order_id, restaurant_id, ticket_hash, state, attempt_count,
           last_error, printed_at, updated_at
    from print_jobs
    order by
      (state = 'DEAD_LETTER') desc,
      (state = 'FAILED') desc,
      updated_at desc
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    restaurantId: row.restaurant_id,
    ticketHash: row.ticket_hash,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error,
    printedAt: isoOrNull(row.printed_at),
    updatedAt: iso(row.updated_at),
  }));
}

/**
 * Kafka events consumed, broken down by consumer. The total is in `readDatabaseCounters`; this is
 * what makes "the realtime consumer is at 412 and the kitchen is at 87" — an ADR 012 problem,
 * because the kitchen projection is load-bearing for writes — readable at a glance.
 */
export async function readConsumedByConsumer(
  db: Db,
): Promise<{ consumer: string; count: number }[]> {
  const result = await db.execute<{ consumer_name: string; total: string }>(sql`
    select consumer_name, count(*) as total
    from processed_events
    group by consumer_name
    order by consumer_name
  `);

  return result.rows.map((row) => ({ consumer: row.consumer_name, count: count(row.total) }));
}
