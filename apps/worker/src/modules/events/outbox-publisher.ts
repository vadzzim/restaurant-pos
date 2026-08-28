import type { DomainEvent } from '@pos/contracts';
import type { Db } from '@pos/db';
import { sql } from 'drizzle-orm';

/**
 * Publishing happens outside every transaction (§7, §10), so the transport is an interface: the
 * worker passes Redpanda, the tests pass a fake that can be told to fail.
 */
export interface EventTransport {
  publish(event: DomainEvent, key: string): Promise<void>;
}

export interface PublisherOptions {
  workerId: string;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface PublishRunResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
}

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  aggregate_id: string;
  restaurant_id: string;
  event_type: string;
  event_version: number;
  payload: unknown;
  trace_id: string | null;
  /** Raw driver rows: Drizzle hands back the PostgreSQL text form, not a Date. */
  created_at: string | Date;
  attempt_count: number;
}

/**
 * One pass of the §10 protocol, in three short steps:
 *
 *   1. claim a batch by lease and COMMIT — `SKIP LOCKED` keeps two workers off the same row
 *      during the claim, the lease keeps them off it during publication;
 *   2. publish outside any transaction;
 *   3. mark the outcome in a second short transaction.
 *
 * A crash between steps 2 and 3 leaves the row claimed until the lease expires and then
 * republishes it. **Publication is therefore at-least-once**, which is exactly why the consumers
 * deduplicate on `event_id` (§12).
 *
 * Per-order ordering is the claim query's job, not this loop's: see `claimBatch`.
 */
export async function publishOnce(
  db: Db,
  transport: EventTransport,
  options: PublisherOptions,
): Promise<PublishRunResult> {
  const claimed = await claimBatch(db, options);
  const result: PublishRunResult = {
    claimed: claimed.length,
    published: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (const row of claimed) {
    const event = toDomainEvent(row);

    try {
      await transport.publish(event, row.aggregate_id);
    } catch (error) {
      const deadLettered = await recordFailure(db, row, error, options);
      result.failed += 1;
      if (deadLettered) {
        result.deadLettered += 1;
      }
      continue;
    }

    await markPublished(db, row.id);
    result.published += 1;
  }

  return result;
}

/**
 * Claims at most **one** row per aggregate: the earliest unpublished event of that order. A later
 * event becomes claimable only once its predecessor is published, so a single order's events reach
 * Redpanda in version order no matter how many workers run, how a batch is ordered internally, or
 * which publish fails and goes back for a retry. Kafka then preserves that order within the
 * partition the order id keys into (§11).
 *
 * A dead-lettered event deliberately stops blocking its successors: the alternative is one poison
 * event freezing an order forever, and `/debug` surfaces dead letters for a human to act on.
 */
async function claimBatch(db: Db, options: PublisherOptions): Promise<ClaimedRow[]> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<ClaimedRow>(sql`
      with claimed as (
        update outbox_events
        set claimed_by = ${options.workerId},
            claim_until = now() + ${`${options.leaseMs} milliseconds`}::interval
        where id in (
          select pending.id from outbox_events pending
          where pending.published_at is null
            and pending.dead_lettered_at is null
            and pending.next_attempt_at <= now()
            and (pending.claim_until is null or pending.claim_until < now())
            and not exists (
              select 1 from outbox_events earlier
              where earlier.aggregate_id = pending.aggregate_id
                and earlier.published_at is null
                and earlier.dead_lettered_at is null
                and (earlier.event_version, earlier.created_at, earlier.id)
                    < (pending.event_version, pending.created_at, pending.id)
            )
          order by pending.next_attempt_at
          limit ${options.batchSize}
          for update skip locked
        )
        returning *
      )
      select * from claimed order by created_at, event_version
    `);

    return [...claimed.rows];
  });
}

async function markPublished(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update outbox_events
      set published_at = now(), claimed_by = null, claim_until = null, last_error = null
      where id = ${id}
    `);
  });
}

/** Retries live in PostgreSQL, not in a second queue (ADR 010): bounded exponential backoff. */
async function recordFailure(
  db: Db,
  row: ClaimedRow,
  error: unknown,
  options: PublisherOptions,
): Promise<boolean> {
  const attempt = row.attempt_count + 1;
  const deadLettered = attempt >= options.maxAttempts;
  const delayMs = Math.min(options.backoffBaseMs * 2 ** (attempt - 1), options.backoffMaxMs);
  const message = error instanceof Error ? error.message : String(error);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update outbox_events
      set attempt_count = ${attempt},
          last_error = ${message},
          next_attempt_at = now() + ${`${delayMs} milliseconds`}::interval,
          dead_lettered_at = ${deadLettered ? sql`now()` : sql`null`},
          claimed_by = null,
          claim_until = null
      where id = ${row.id}
    `);
  });

  return deadLettered;
}

function toDomainEvent(row: ClaimedRow): DomainEvent {
  return {
    eventId: row.id,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    restaurantId: row.restaurant_id,
    version: row.event_version,
    occurredAt: new Date(row.created_at).toISOString(),
    traceId: row.trace_id ?? undefined,
    payload: row.payload,
  };
}
