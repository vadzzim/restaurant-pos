import { randomUUID } from 'node:crypto';

import type { DomainEvent } from '@pos/contracts';
import { kitchenTickets, orders, outboxEvents, processedEvents, type Db } from '@pos/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { OutboxControls } from '../src/modules/events/outbox-controls.js';
import {
  maxPublishDelayMs,
  publishOnce,
  type EventTransport,
  type PublisherOptions,
} from '../src/modules/events/outbox-publisher.js';
import { applyKitchenEvent } from '../src/modules/kitchen/projection.js';
import { db, useTestDatabase } from './helpers.js';

useTestDatabase();

const options: PublisherOptions = {
  workerId: 'worker-under-test',
  batchSize: 10,
  leaseMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
};

function recordingTransport(): EventTransport & { sent: DomainEvent[]; keys: string[] } {
  const sent: DomainEvent[] = [];
  const keys: string[] = [];
  return {
    sent,
    keys,
    publish: async (event, key) => {
      sent.push(event);
      keys.push(key);
    },
  };
}

const failingTransport: EventTransport = {
  publish: async () => {
    throw new Error('broker unreachable');
  },
};

async function seedEvent(orderId: string, eventVersion: number): Promise<string> {
  const eventId = randomUUID();

  await db().insert(outboxEvents).values({
    id: eventId,
    aggregateId: orderId,
    aggregateType: 'order',
    restaurantId: 'demo-restaurant',
    eventType: 'OrderItemAdded',
    eventVersion,
    payload: { orderId },
  });

  return eventId;
}

async function seedOrderWithEvent(): Promise<{ orderId: string; eventId: string }> {
  const orderId = randomUUID();
  const eventId = randomUUID();

  await db().insert(orders).values({
    id: orderId,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status: 'SENT_TO_KITCHEN',
    version: 2,
    totalCents: 1200,
  });

  await db()
    .insert(outboxEvents)
    .values({
      id: eventId,
      aggregateId: orderId,
      aggregateType: 'order',
      restaurantId: 'demo-restaurant',
      eventType: 'OrderSentToKitchen',
      eventVersion: 2,
      payload: { orderId, tableNumber: '12', items: [], totalCents: 1200 },
    });

  return { orderId, eventId };
}

async function eventRow(eventId: string) {
  const [row] = await db().select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
  return row;
}

describe('the outbox publisher', () => {
  it('claims, publishes outside the transaction, then marks the row published', async () => {
    const { orderId, eventId } = await seedOrderWithEvent();
    const transport = recordingTransport();

    const result = await publishOnce(db(), transport, options);

    expect(result).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
      deadLettered: 0,
      abandoned: 0,
      reclaimed: 0,
    });
    expect(transport.sent[0]?.eventId).toBe(eventId);
    // The message key is the order id, which is what keeps one order's events in one partition.
    expect(transport.keys).toEqual([orderId]);

    const row = await eventRow(eventId);
    expect(row?.publishedAt).not.toBeNull();
    expect(row?.claimedBy).toBeNull();
    expect(row?.claimUntil).toBeNull();
  });

  it('does not claim a row that is already published', async () => {
    const { eventId } = await seedOrderWithEvent();
    const transport = recordingTransport();

    await publishOnce(db(), transport, options);
    const second = await publishOnce(db(), transport, options);

    expect(second.claimed).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(eventId).toBeDefined();
  });

  it('schedules a retry with backoff when the broker rejects the publish', async () => {
    const { eventId } = await seedOrderWithEvent();

    const result = await publishOnce(db(), failingTransport, options);

    expect(result).toEqual({
      claimed: 1,
      published: 0,
      failed: 1,
      deadLettered: 0,
      abandoned: 0,
      reclaimed: 0,
    });

    const row = await eventRow(eventId);
    expect(row?.publishedAt).toBeNull();
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastError).toContain('broker unreachable');
    expect(row?.deadLetteredAt).toBeNull();
    expect(row?.claimedBy).toBeNull();
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('dead-letters a row that exhausts its attempts instead of dropping it', async () => {
    const { eventId } = await seedOrderWithEvent();
    const impatient: PublisherOptions = { ...options, backoffBaseMs: 1, backoffMaxMs: 1 };

    for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
      await publishOnce(db(), failingTransport, impatient);
      // The backoff is one millisecond, so the row is claimable again on the next pass.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const row = await eventRow(eventId);
    expect(row?.attemptCount).toBe(options.maxAttempts);
    expect(row?.deadLetteredAt).not.toBeNull();

    const afterDeadLetter = await publishOnce(db(), failingTransport, impatient);
    expect(afterDeadLetter.claimed).toBe(0);
  });
});

describe('per-order ordering', () => {
  it('claims only the earliest pending event of an order, so v2 cannot overtake v1', async () => {
    const orderId = randomUUID();
    const first = await seedEvent(orderId, 1);
    const second = await seedEvent(orderId, 2);
    const transport = recordingTransport();

    const pass = await publishOnce(db(), transport, options);
    expect(pass.claimed).toBe(1);
    expect(transport.sent.map((event) => event.eventId)).toEqual([first]);

    await publishOnce(db(), transport, options);
    expect(transport.sent.map((event) => event.eventId)).toEqual([first, second]);
    expect(transport.sent.map((event) => event.version)).toEqual([1, 2]);
  });

  it('holds later events of the same order back while an earlier one is retrying', async () => {
    const orderId = randomUUID();
    const first = await seedEvent(orderId, 1);
    await seedEvent(orderId, 2);
    const impatient: PublisherOptions = { ...options, backoffBaseMs: 1, backoffMaxMs: 1 };

    await publishOnce(db(), failingTransport, impatient);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // v1 is back in the queue: the next pass must retry it, never skip ahead to v2.
    const transport = recordingTransport();
    const retry = await publishOnce(db(), transport, impatient);

    expect(retry.published).toBe(1);
    expect(transport.sent.map((event) => event.eventId)).toEqual([first]);
  });

  it('still batches events belonging to different orders', async () => {
    const firstOrder = randomUUID();
    const secondOrder = randomUUID();
    await seedEvent(firstOrder, 1);
    await seedEvent(secondOrder, 1);
    const transport = recordingTransport();

    const pass = await publishOnce(db(), transport, options);

    expect(pass.claimed).toBe(2);
    expect(pass.published).toBe(2);
  });
});

/**
 * The M6 review's P1, from the other end. The supervisor kills the session on the first failed
 * send, and this is what stops the rest of that batch being charged an `attempt_count` for the same
 * outage — otherwise a full batch would burn fifty attempts on one broker blip, and dead-lettering
 * would stop meaning "this event is bad".
 */
describe('a batch interrupted by the broker going away', () => {
  it('spends one attempt and abandons the rest of the claim untouched', async () => {
    const first = await seedOrderWithEvent();
    const second = await seedOrderWithEvent();
    const third = await seedOrderWithEvent();

    let alive = true;
    const dyingTransport: EventTransport = {
      publish: async () => {
        alive = false;
        throw new Error('broker unreachable');
      },
    };

    const result = await publishOnce(db(), dyingTransport, {
      ...options,
      isTransportAlive: () => alive,
    });

    expect(result).toMatchObject({
      claimed: 3,
      published: 0,
      failed: 1,
      abandoned: 2,
      stoppedBecause: 'transport',
    });

    const rows = await Promise.all(
      [first, second, third].map(async ({ eventId }) => await eventRow(eventId)),
    );
    // Exactly one row learned anything; the other two are untouched.
    const attempts = rows.map((row) => row?.attemptCount);
    expect(attempts.filter((count) => count === 1)).toHaveLength(1);
    expect(attempts.filter((count) => count === 0)).toHaveLength(2);

    // M9: and the two untouched rows are handed straight back rather than left leased for
    // `OUTBOX_LEASE_MS`. Nothing is working on them, so nothing should be waiting for them.
    expect(rows.every((row) => row?.claimedBy === null)).toBe(true);
    expect(rows.every((row) => row?.claimUntil === null)).toBe(true);
  });
});

/**
 * Simulates the worker process dying at a chosen transaction. `publishOnce` opens exactly two: the
 * claim, and then the mark. Killing the second is therefore the §21.12 window itself — the record
 * has reached the transport and `published_at` was never written — and it is a real crash rather
 * than a row edited after the fact to look like one.
 */
function dbThatDiesOnTransaction(nth: number): Db {
  const real = db();
  let started = 0;

  return new Proxy(real, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);

      if (property !== 'transaction' || typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]): unknown => {
        started += 1;
        if (started === nth) {
          return Promise.reject(new Error('worker killed mid-publish'));
        }
        return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * Moves `claim_until` into the past instead of sleeping until it gets there. The behaviour under
 * test is "an expired lease is re-claimable", not "time passes": a sleep long enough to be reliable
 * on a loaded machine would make every one of these tests a stopwatch race, and a short one would
 * make them flaky. `now()` is the database's, so this is the same comparison the claim query makes.
 */
async function expireLease(eventId: string): Promise<void> {
  await db().execute(sql`
    update outbox_events set claim_until = now() - interval '1 second' where id = ${eventId}
  `);
}

function controlsOf(paused: boolean, publishDelayMs = 0): () => OutboxControls {
  return () => ({ paused, publishDelayMs });
}

/**
 * §21.12 — crash after publish, before `published_at`.
 *
 * This is the window §10 accepts on purpose: there is no ordering of "send to Redpanda" and "write
 * to PostgreSQL" that makes them atomic, and holding a transaction open across the send is what §7
 * forbids. So the event is published twice and the consumer is what makes that harmless.
 */
describe('§21.12 the publish-then-crash window', () => {
  it('republishes the event and the consumer applies the projection exactly once', async () => {
    const { orderId, eventId } = await seedOrderWithEvent();
    const transport = recordingTransport();

    await expect(publishOnce(dbThatDiesOnTransaction(2), transport, options)).rejects.toThrow(
      'worker killed mid-publish',
    );

    // The record is on the topic and the row does not know it: the window, exactly.
    expect(transport.sent).toHaveLength(1);
    const crashed = await eventRow(eventId);
    expect(crashed?.publishedAt).toBeNull();
    expect(crashed?.claimedBy).toBe(options.workerId);
    expect(crashed?.attemptCount).toBe(0);

    const firstDelivery = transport.sent[0] as DomainEvent;
    expect(await applyKitchenEvent(db(), firstDelivery)).toBe('applied');

    // While the lease stands the row belongs to the dead worker, so nothing republishes early.
    expect((await publishOnce(db(), transport, options)).claimed).toBe(0);

    await expireLease(eventId);
    const republish = await publishOnce(db(), transport, options);
    expect(republish).toMatchObject({ claimed: 1, published: 1, failed: 0, reclaimed: 1 });
    expect(transport.sent).toHaveLength(2);

    const redelivery = transport.sent[1] as DomainEvent;
    expect(redelivery.eventId).toBe(eventId);

    const republished = await eventRow(eventId);
    // The row was never at fault, so republishing it costs no attempt and cannot dead-letter it.
    expect(republished?.attemptCount).toBe(0);
    expect(republished?.reclaimCount).toBe(1);
    expect(republished?.publishedAt).not.toBeNull();

    expect(await applyKitchenEvent(db(), redelivery)).toBe('duplicate');

    const tickets = await db()
      .select()
      .from(kitchenTickets)
      .where(eq(kitchenTickets.orderId, orderId));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.sourceEventVersion).toBe(2);

    const processed = await db()
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, eventId));
    expect(processed).toHaveLength(1);
  });
});

/**
 * §21.16 — the lease, with two workers running against one database.
 *
 * The first half is deterministic without a clock: worker A's claim commits before its first send
 * (that is the shape of the §10 protocol), so gating B on A's first send means B provably runs
 * while A holds every row.
 */
describe('§21.16 the outbox lease under two workers', () => {
  it('never lets a second worker claim a row the first is still holding', async () => {
    await seedOrderWithEvent();
    await seedOrderWithEvent();
    await seedOrderWithEvent();

    let firstSendReached = (): void => {};
    const sending = new Promise<void>((resolve) => {
      firstSendReached = resolve;
    });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const workerA = publishOnce(
      db(),
      {
        publish: async () => {
          firstSendReached();
          await gate;
        },
      },
      { ...options, workerId: 'worker-a' },
    );

    await sending;

    const workerB = await publishOnce(db(), recordingTransport(), {
      ...options,
      workerId: 'worker-b',
    });

    expect(workerB.claimed).toBe(0);
    expect(workerB.published).toBe(0);

    release();
    expect((await workerA).published).toBe(3);
  });

  it('lets a second worker take over from a worker that died, and counts the reclaim', async () => {
    const { eventId } = await seedOrderWithEvent();
    const transport = recordingTransport();

    await expect(
      publishOnce(dbThatDiesOnTransaction(2), transport, { ...options, workerId: 'worker-a' }),
    ).rejects.toThrow('worker killed mid-publish');

    const beforeExpiry = await publishOnce(db(), transport, { ...options, workerId: 'worker-b' });
    expect(beforeExpiry.claimed).toBe(0);

    await expireLease(eventId);

    const afterExpiry = await publishOnce(db(), transport, { ...options, workerId: 'worker-b' });
    expect(afterExpiry).toMatchObject({ claimed: 1, published: 1, reclaimed: 1 });

    const row = await eventRow(eventId);
    expect(row?.publishedAt).not.toBeNull();
    expect(row?.claimedBy).toBeNull();
    // A reclaim is a worker dying, not a bad event, so it is counted separately and never
    // dead-letters the row.
    expect(row?.reclaimCount).toBe(1);
    expect(row?.attemptCount).toBe(0);
  });
});

/** The two §18 switches, honoured by a running pass rather than by a restart. */
describe('the outbox controls', () => {
  it('stops mid-batch when the publisher is paused and hands back what it will not publish', async () => {
    const first = await seedOrderWithEvent();
    const second = await seedOrderWithEvent();
    const third = await seedOrderWithEvent();

    let paused = false;
    const pausingTransport: EventTransport = {
      publish: async () => {
        paused = true;
      },
    };

    const result = await publishOnce(db(), pausingTransport, {
      ...options,
      controls: () => ({ paused, publishDelayMs: 0 }),
    });

    expect(result).toMatchObject({
      claimed: 3,
      published: 1,
      failed: 0,
      abandoned: 2,
      stoppedBecause: 'paused',
    });

    // A paused publisher holding leases would stall every other worker for `OUTBOX_LEASE_MS`,
    // which is the opposite of what an operational switch is for.
    const rows = await Promise.all(
      [first, second, third].map(async ({ eventId }) => await eventRow(eventId)),
    );
    expect(rows.filter((row) => row?.publishedAt !== null)).toHaveLength(1);
    expect(rows.every((row) => row?.claimedBy === null)).toBe(true);
    expect(rows.every((row) => row?.attemptCount === 0)).toBe(true);
  });

  it('waits the configured delay before a send', async () => {
    await seedOrderWithEvent();
    const transport = recordingTransport();

    const startedAt = Date.now();
    const result = await publishOnce(db(), transport, {
      ...options,
      controls: controlsOf(false, 120),
    });

    expect(result.published).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });

  it('stops a batch rather than send under a lease that is nearly up', async () => {
    await seedOrderWithEvent();
    await seedOrderWithEvent();
    await seedOrderWithEvent();
    const transport = recordingTransport();

    // 400 ms of lease, a tenth of it held back, and a delay of 250 ms before each send: the first
    // send fits, the second provably does not. Publishing it anyway would mean sending under a
    // lease another worker may already have taken — the one way this design reorders an order's
    // events rather than merely duplicating one.
    const result = await publishOnce(db(), transport, {
      ...options,
      leaseMs: 400,
      controls: controlsOf(false, 250),
    });

    expect(result).toMatchObject({
      claimed: 3,
      published: 1,
      failed: 0,
      abandoned: 2,
      stoppedBecause: 'lease',
    });
    expect(transport.sent).toHaveLength(1);
  });
});

/**
 * Review round 1's P1 and P2, both about the lease and the switch being checked at the wrong
 * moment: the first version budgeted the *artificial delay* against the lease and then let the send
 * itself run unbounded, and it read the controls once per row rather than once per wait.
 */
describe('the review found: the lease bounded only what came before the send', () => {
  it('gives up on a send still outstanding when the lease runs out, and spends no attempt', async () => {
    const { eventId } = await seedOrderWithEvent();

    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sessionEnded = 0;

    try {
      const result = await publishOnce(
        db(),
        { publish: async () => gate },
        {
          ...options,
          leaseMs: 300,
          onLeaseOverrun: () => {
            sessionEnded += 1;
          },
        },
      );

      expect(result).toMatchObject({
        claimed: 1,
        published: 0,
        failed: 0,
        abandoned: 1,
        stoppedBecause: 'lease',
      });
      // A producer that slow is not usable: the session is torn down and rebuilt, which is also the
      // nearest thing to cancelling the request that KafkaJS offers.
      expect(sessionEnded).toBe(1);

      const row = await eventRow(eventId);
      // The broker was slow; the event was not bad. No attempt, no dead letter, and the claim goes
      // back so whoever picks the row up next is not waiting out a lease nobody is using.
      expect(row?.attemptCount).toBe(0);
      expect(row?.publishedAt).toBeNull();
      expect(row?.claimedBy).toBeNull();
    } finally {
      release();
    }
  });

  it('re-reads the switch after the delay, so a pause lands within a poll and not a delay', async () => {
    await seedOrderWithEvent();
    const transport = recordingTransport();

    // The switch is read once before the wait and once after it. Answering "running" first and
    // "paused" from then on is a pause thrown *during* the delay, with no timer to race.
    let reads = 0;
    const controls = (): OutboxControls => {
      reads += 1;
      return { paused: reads > 1, publishDelayMs: 10 };
    };

    const result = await publishOnce(db(), transport, { ...options, controls });

    expect(reads).toBeGreaterThan(1);
    expect(result).toMatchObject({
      claimed: 1,
      published: 0,
      abandoned: 1,
      stoppedBecause: 'paused',
    });
    // The row waited out its delay and was then not sent, which is what a pause has to mean.
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses a publish delay that cannot fit inside the lease', () => {
    // Half the lease budget, so a send and the claim's round trip still have room. With the
    // shipped 30 s lease that is 13.5 s — well past anything a demo needs to make visible.
    expect(maxPublishDelayMs(30_000)).toBe(13_500);
    // The ceiling has to stay under the budget the pass actually enforces, or accepting a delay
    // would still produce a pass that claims rows and publishes nothing.
    expect(maxPublishDelayMs(30_000)).toBeLessThan(30_000 * 0.9);
  });
});
