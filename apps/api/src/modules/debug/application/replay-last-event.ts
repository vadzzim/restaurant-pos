import type { ReplayedEventView } from '@pos/contracts';
import type { Db } from '@pos/db';
import { sql } from 'drizzle-orm';

interface ReplayRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  aggregate_id: string;
  event_version: number;
  published_at: string;
}

/**
 * §18's `Replay Last Kafka Event`, and therefore §19.6.
 *
 * **The API grows no Kafka producer for a demo button.** The publisher is the only thing in this
 * system that writes to the topic (§10, ADR 010), so a replay is expressed as the only thing that
 * makes it write: the newest published row is put back into the claimable state. Within one
 * `OUTBOX_POLL_MS` the worker claims it and sends it again, and both consumers deduplicate it
 * through `processed_events` — which is the demonstration the control exists for. A producer here
 * would put an event on the topic that the outbox has no record of having re-sent.
 *
 * `published_at` is read in the CTE and not from `RETURNING`, which gives back the new values —
 * and the new value is the `null` this statement just wrote. The publisher's `claimBatch` says the
 * same thing about the same trap.
 *
 * `attempt_count` goes back to zero with the rest. A row that needed two retries to publish the
 * first time would otherwise start its replay two attempts into `OUTBOX_MAX_ATTEMPTS` and
 * dead-letter sooner than a fresh event — the button would then be demonstrating the retry budget
 * of the original send rather than of the replay.
 *
 * `FOR UPDATE SKIP LOCKED` rather than a plain lock: two clicks racing take two *different* rows,
 * the newest and the one behind it, instead of one waiting to replay a row the other has already
 * unpublished. Each click therefore replays one event, which is what the button says it does.
 *
 * Two consequences worth knowing, both in `known-problems.md`: the published count drops by one
 * while the row is back in flight, and the replayed row is *earlier* than any still-unpublished
 * event for the same aggregate, so the claim query holds those behind it until it lands.
 */
export async function replayLastEvent(db: Db): Promise<ReplayedEventView | null> {
  const result = await db.execute<ReplayRow>(sql`
    with target as (
      select id, published_at
      from outbox_events
      where published_at is not null
        and dead_lettered_at is null
      order by published_at desc, created_at desc, id desc
      limit 1
      for update skip locked
    ),
    replayed as (
      update outbox_events
      set published_at = null,
          claimed_by = null,
          claim_until = null,
          last_error = null,
          attempt_count = 0,
          next_attempt_at = now()
      from target
      where outbox_events.id = target.id
      returning outbox_events.id, outbox_events.event_type,
                outbox_events.aggregate_id, outbox_events.event_version
    )
    select replayed.*, target.published_at
    from replayed join target on target.id = replayed.id
  `);

  const [row] = result.rows;
  if (row === undefined) {
    return null;
  }

  return {
    eventId: row.id,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    eventVersion: row.event_version,
    previouslyPublishedAt: new Date(row.published_at).toISOString(),
  };
}
