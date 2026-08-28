import type { DomainEvent } from '@pos/contracts';
import type { Db } from '@pos/db';
import { sql } from 'drizzle-orm';

import { DEFAULT_OUTBOX_CONTROLS, type OutboxControls } from './outbox-controls.js';

/**
 * Publishing happens outside every transaction (§7, §10), so the transport is an interface: the
 * worker passes Redpanda, the tests pass a fake that can be told to fail.
 */
export interface EventTransport {
  publish(event: DomainEvent, key: string): Promise<void>;
}

/**
 * How much of the lease a pass refuses to spend. A batch that publishes right up to `claim_until`
 * is publishing under a lease another worker may already have taken, and the local clock is not the
 * database's — so the last tenth of the lease is left unused rather than gambled.
 */
const LEASE_SAFETY_FRACTION = 0.1;

export interface PublisherOptions {
  workerId: string;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /**
   * Ends the pass early when the transport is no longer usable. Without it, the broker dropping
   * mid-batch costs one `attempt_count` on every remaining row for a reason that has nothing to do
   * with those rows — `attempt_count` has to keep meaning "this event failed", not "the broker
   * went away while it was in the queue" (ADR 011). Defaults to always alive, which is what the
   * tests with a fake transport want.
   */
  isTransportAlive?: (() => boolean) | undefined;
  /**
   * The §18 switches, read between rows so a pause takes effect inside a batch rather than after
   * it. Synchronous on purpose: the worker keeps a polled snapshot (`watchOutboxControls`) so this
   * costs no query per row.
   */
  controls?: (() => OutboxControls) | undefined;
}

/** Why a pass stopped before working through everything it claimed. */
export type PublishStopReason =
  /** The broker went away mid-batch. */
  | 'transport'
  /** A human paused the publisher (§18). */
  | 'paused'
  /** The claim's lease would not have covered the next send. */
  | 'lease';

export interface PublishRunResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
  /**
   * Claimed but never attempted, because the pass stopped first. These spend no attempt — which is
   * the whole point — and their claims are released immediately rather than left to expire.
   */
  abandoned: number;
  /** Rows taken from a previous claimant whose lease had expired: somebody's worker died (§21.16). */
  reclaimed: number;
  stoppedBecause?: PublishStopReason;
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
  /** The claimant this row was taken from, or `null` when it was free. Not a column: see `claimBatch`. */
  previous_owner: string | null;
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
 *
 * The pass stops early for three reasons — the transport died, a human paused the publisher, or
 * the lease is nearly up — and in all three it **releases the claims it will not use**. Leaving
 * them to expire would stall the next pass, and any other worker, for up to `OUTBOX_LEASE_MS` for
 * rows nobody is working on.
 */
export async function publishOnce(
  db: Db,
  transport: EventTransport,
  options: PublisherOptions,
): Promise<PublishRunResult> {
  const claimedAt = Date.now();
  const claimed = await claimBatch(db, options);
  const result: PublishRunResult = {
    claimed: claimed.length,
    published: 0,
    failed: 0,
    deadLettered: 0,
    abandoned: 0,
    reclaimed: claimed.filter((row) => row.previous_owner !== null).length,
  };

  // Measured from before the claim, never from after it: the claim's own round trip is spent out
  // of the same lease, and a slow one is exactly when this guard matters.
  const leaseDeadline = claimedAt + options.leaseMs * (1 - LEASE_SAFETY_FRACTION);

  for (const [index, row] of claimed.entries()) {
    const controls = options.controls?.() ?? DEFAULT_OUTBOX_CONTROLS;
    const stopReason = reasonToStop(options, controls, leaseDeadline);

    if (stopReason !== undefined) {
      const abandoned = claimed.slice(index);
      result.abandoned = abandoned.length;
      result.stoppedBecause = stopReason;
      await releaseClaims(
        db,
        abandoned.map((abandonedRow) => abandonedRow.id),
        options.workerId,
      );
      break;
    }

    if (controls.publishDelayMs > 0) {
      await sleep(controls.publishDelayMs);
    }

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
 * The three ways a pass gives up on rows it already holds. The lease check counts the delay it is
 * about to incur, because a `publish_delay_ms` large enough to matter is large enough to be the
 * thing that overruns the lease.
 */
function reasonToStop(
  options: PublisherOptions,
  controls: OutboxControls,
  leaseDeadline: number,
): PublishStopReason | undefined {
  // Every remaining send would fail for the same reason and charge every remaining row for it.
  if (options.isTransportAlive?.() === false) {
    return 'transport';
  }
  if (controls.paused) {
    return 'paused';
  }
  if (Date.now() + controls.publishDelayMs >= leaseDeadline) {
    return 'lease';
  }
  return undefined;
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
 *
 * The candidate rows are selected in their own CTE so the update can see who held each row
 * *before* it: `RETURNING` gives back new values only, and "this row was taken from a claimant
 * whose lease ran out" is the one symptom of a worker dying mid-publish. It is counted on the row
 * (`reclaim_count`) and returned to the caller; it never spends an `attempt_count`, because a
 * reclaim says a worker died, not that the event is bad (ADR 010).
 */
async function claimBatch(db: Db, options: PublisherOptions): Promise<ClaimedRow[]> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<ClaimedRow>(sql`
      with candidates as (
        select pending.id, pending.claimed_by as previous_owner
        from outbox_events pending
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
      ),
      claimed as (
        update outbox_events
        set claimed_by = ${options.workerId},
            claim_until = now() + ${`${options.leaseMs} milliseconds`}::interval,
            reclaim_count = outbox_events.reclaim_count
              + case when candidates.previous_owner is null then 0 else 1 end
        from candidates
        where outbox_events.id = candidates.id
        returning outbox_events.*, candidates.previous_owner
      )
      select * from claimed order by created_at, event_version
    `);

    return [...claimed.rows];
  });
}

/**
 * Deliberately **not** guarded on `claimed_by`. If our lease did expire under us, the event still
 * reached the topic, and refusing to record that would republish it forever. A second worker
 * publishing a duplicate in the meantime is the at-least-once guarantee doing its job (§10); an
 * event that can never be marked published is not.
 */
async function markPublished(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update outbox_events
      set published_at = now(), claimed_by = null, claim_until = null, last_error = null
      where id = ${id}
    `);
  });
}

/**
 * Hands back the rows a pass claimed and will not publish, so the next pass — or another worker —
 * can take them immediately instead of waiting out `OUTBOX_LEASE_MS`.
 *
 * Guarded on `claimed_by`: if this pass was slow enough that its lease expired and someone else
 * re-claimed these rows, releasing them would hand a row to a third worker while the second is
 * mid-publish. `published_at is null` is the same caution one step further on.
 *
 * A crash before this statement leaves exactly the behaviour that existed before it: the leases
 * stand until they expire. That is why it is safe for the release to be a best-effort optimisation
 * rather than part of a transaction with anything else.
 */
async function releaseClaims(db: Db, ids: string[], workerId: string): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

  await db.execute(sql`
    update outbox_events
    set claimed_by = null, claim_until = null
    where id in (${idList})
      and claimed_by = ${workerId}
      and published_at is null
  `);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
