import { randomUUID } from 'node:crypto';

import type {
  ConflictsDebugResponse,
  EventsDebugResponse,
  MetricsResponse,
  OutboxDebugResponse,
  PresenceEntry,
} from '@pos/contracts';
import { outboxEvents, printJobs, processedEvents } from '@pos/db';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { resetCounters } from '../src/modules/debug/application/counters.js';
import type { PresenceStore, SharedCounterStore } from '../src/modules/debug/application/ports.js';
import { applyMutation } from '../src/modules/orders/application/mutation-handler.js';
import { DEMO_RESTAURANT, SECOND_RESTAURANT, db, testApp, useTestDatabase } from './helpers.js';

useTestDatabase();

// Counters are module state and therefore process-wide: without this the third test in this file
// would be asserting against the first two tests' traffic.
beforeEach(() => {
  resetCounters();
});

async function createOrder(orderId: string): Promise<void> {
  await applyMutation(db(), {
    orderId,
    mutationId: randomUUID(),
    terminalId: 'pos-1',
    restaurantId: DEMO_RESTAURANT,
    baseVersion: 0,
    type: 'CREATE_ORDER',
    payload: { tableNumber: '7' },
  });
}

async function insertOutboxRow(overrides: Partial<typeof outboxEvents.$inferInsert> = {}) {
  const id = randomUUID();
  await db()
    .insert(outboxEvents)
    .values({
      id,
      aggregateId: randomUUID(),
      aggregateType: 'order',
      restaurantId: DEMO_RESTAURANT,
      eventType: 'OrderCreated',
      eventVersion: 1,
      payload: {},
      ...overrides,
    });
  return id;
}

describe('GET /api/debug/events', () => {
  it('streams outbox rows newest first with the consumers that have recorded them', async () => {
    const app = testApp();
    const consumed = await insertOutboxRow({ eventType: 'OrderCreated' });
    await db()
      .insert(processedEvents)
      .values([
        { eventId: consumed, consumerName: 'kitchen' },
        { eventId: consumed, consumerName: 'realtime' },
      ]);
    await insertOutboxRow({ eventType: 'OrderSentToKitchen', eventVersion: 2 });

    const response = await app.inject({ method: 'GET', url: '/api/debug/events' });

    expect(response.statusCode).toBe(200);
    const body = response.json<EventsDebugResponse>();
    expect(body.events).toHaveLength(2);
    expect(body.events.find((event) => event.eventId === consumed)?.consumedBy).toEqual([
      'kitchen',
      'realtime',
    ]);
    // An event nothing has consumed reports an empty list, not a null: "no consumer has seen this"
    // is the reading, and it must not be confused with "the join failed".
    expect(body.events.find((event) => event.eventId !== consumed)?.consumedBy).toEqual([]);

    await app.close();
  });

  it('refuses a limit above the configured page size instead of returning the whole table', async () => {
    const app = buildApp({ db: db(), logLevel: 'silent', debugRowLimit: 10 });

    const response = await app.inject({ method: 'GET', url: '/api/debug/events?limit=5000' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED');

    await app.close();
  });
});

describe('GET /api/debug/conflicts', () => {
  it('reports the totals from the table, not from the page it returned', async () => {
    const app = buildApp({ db: db(), logLevel: 'silent', debugRowLimit: 1 });
    const orderId = randomUUID();
    await createOrder(orderId);

    // Two conflicts against the same order: the second terminal is behind, twice over.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await applyMutation(db(), {
        orderId,
        mutationId: randomUUID(),
        terminalId: 'pos-2',
        restaurantId: DEMO_RESTAURANT,
        baseVersion: 99,
        type: 'SEND_TO_KITCHEN',
        payload: {},
      });
    }

    const response = await app.inject({ method: 'GET', url: '/api/debug/conflicts' });

    const body = response.json<ConflictsDebugResponse>();
    expect(body.conflicts).toHaveLength(1);
    expect(body.total).toBe(2);
    // Nothing writes `resolution` yet, so every conflict counts as a halted client queue.
    expect(body.unresolved).toBe(2);

    await app.close();
  });
});

describe('GET /api/debug/outbox', () => {
  it('puts dead-lettered rows first and carries the reclaim count', async () => {
    const app = testApp();
    await insertOutboxRow({ publishedAt: new Date(), eventType: 'OrderCreated' });
    const dead = await insertOutboxRow({
      deadLetteredAt: new Date(),
      attemptCount: 8,
      lastError: 'broker refused the record',
      reclaimCount: 3,
      eventType: 'OrderPaid',
    });

    const response = await app.inject({ method: 'GET', url: '/api/debug/outbox' });

    const body = response.json<OutboxDebugResponse>();
    expect(body.outbox.rows[0]?.id).toBe(dead);
    expect(body.outbox.rows[0]?.reclaimCount).toBe(3);
    expect(body.outbox.deadLettered).toBe(1);
    expect(body.outbox.published).toBe(1);

    await app.close();
  });

  it('counts print jobs by state and shows the dead-lettered ones first', async () => {
    const app = testApp();
    const orderId = randomUUID();
    await createOrder(orderId);

    await db()
      .insert(printJobs)
      .values([
        {
          id: randomUUID(),
          orderId,
          restaurantId: DEMO_RESTAURANT,
          ticketHash: 'hash-printed',
          state: 'PRINTED',
          printedAt: new Date(),
        },
        {
          id: randomUUID(),
          orderId,
          restaurantId: DEMO_RESTAURANT,
          ticketHash: 'hash-dead',
          state: 'DEAD_LETTER',
          attemptCount: 5,
          lastError: 'printer offline',
        },
      ]);

    const response = await app.inject({ method: 'GET', url: '/api/debug/outbox' });

    const body = response.json<OutboxDebugResponse>();
    expect(body.printJobs.printed).toBe(1);
    expect(body.printJobs.deadLettered).toBe(1);
    expect(body.printJobs.rows[0]?.state).toBe('DEAD_LETTER');

    await app.close();
  });
});

describe('GET /api/debug/metrics', () => {
  it('labels every counter with the source that decides whether it survives a restart', async () => {
    const app = testApp();

    const response = await app.inject({ method: 'GET', url: '/api/debug/metrics' });

    const body = response.json<MetricsResponse>();
    const sources = new Set(body.counters.map((counter) => counter.source));
    expect(sources).toContain('process');
    expect(sources).toContain('database');
    expect(sources).toContain('shared');
    // Every §20 counter has to be present, not merely most of them; the page is the only place
    // this list is checked against the spec.
    for (const name of [
      'apiRequests',
      'apiErrors',
      'activeWebSocketConnections',
      'mutationsReceived',
      'mutationsApplied',
      'duplicateMutationsPrevented',
      'mutationIdReuseRejected',
      'crossTenantRejections',
      'conflictsDetected',
      'blockedMutations',
      'outboxEventsPending',
      'outboxEventsPublished',
      'outboxEventsDeadLettered',
      'kafkaEventsConsumed',
      'duplicateKafkaEventsPrevented',
      'printJobsSucceeded',
      'printJobsFailed',
      'printJobsDeadLettered',
    ]) {
      expect(body.counters.map((counter) => counter.name)).toContain(name);
    }

    await app.close();
  });

  it('counts the four §5 mutation outcomes as they happen', async () => {
    const app = testApp();
    const orderId = randomUUID();

    const send = (body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/orders/${orderId}/mutations`, payload: body });

    const mutationId = randomUUID();
    const create = {
      mutationId,
      terminalId: 'pos-1',
      restaurantId: DEMO_RESTAURANT,
      baseVersion: 0,
      type: 'CREATE_ORDER',
      payload: { tableNumber: '9' },
    };

    await send(create);
    // The same mutationId and the same payload: §9 answers from `processed_mutations`.
    await send(create);
    // The same mutationId, a different payload: a reuse, not a duplicate.
    await send({ ...create, payload: { tableNumber: '10' } });
    // Someone else's restaurant.
    await send({
      mutationId: randomUUID(),
      terminalId: 'pos-3',
      restaurantId: SECOND_RESTAURANT,
      baseVersion: 1,
      type: 'SEND_TO_KITCHEN',
      payload: {},
    });

    const body = (
      await app.inject({ method: 'GET', url: '/api/debug/metrics' })
    ).json<MetricsResponse>();
    const value = (name: string) => body.counters.find((counter) => counter.name === name)?.value;

    expect(value('mutationsReceived')).toBe(4);
    expect(value('mutationsApplied')).toBe(1);
    expect(value('duplicateMutationsPrevented')).toBe(1);
    expect(value('mutationIdReuseRejected')).toBe(1);
    expect(value('crossTenantRejections')).toBe(1);
    // The idempotency ledger holds one row for four requests, which is the §9 claim in a number.
    expect(value('processedMutations')).toBe(1);

    await app.close();
  });

  it('counts requests and errors including the ones no route handler sees', async () => {
    const app = testApp();

    await app.inject({ method: 'GET', url: '/api/menu' });
    await app.inject({ method: 'GET', url: '/api/nothing-here' });

    const body = (
      await app.inject({ method: 'GET', url: '/api/debug/metrics' })
    ).json<MetricsResponse>();
    const value = (name: string) => body.counters.find((counter) => counter.name === name)?.value;

    // Three requests: the menu, the 404 and the metrics read itself is counted *after* its
    // response, so it is not in its own answer.
    expect(value('apiRequests')).toBe(2);
    expect(value('apiErrors')).toBe(1);

    await app.close();
  });

  it('reports a Redis outage as null readings and an empty terminal list, never as zero', async () => {
    const failing: PresenceStore = {
      touch: async () => undefined,
      forget: async () => undefined,
      list: async () => {
        throw new Error('redis is unreachable');
      },
    };
    const failingCounters: SharedCounterStore = {
      read: async () => {
        throw new Error('redis is unreachable');
      },
    };

    const app = buildApp({
      db: db(),
      logLevel: 'silent',
      presence: failing,
      sharedCounters: failingCounters,
    });

    const body = (
      await app.inject({ method: 'GET', url: '/api/debug/metrics' })
    ).json<MetricsResponse>();

    expect(body.terminals).toEqual([]);
    expect(body.presenceError).toContain('redis is unreachable');
    // The whole point of `null`: a Redis outage is invisible today, and a zero here would read as
    // "no duplicates were prevented" rather than "this number could not be read".
    expect(
      body.counters.find((counter) => counter.name === 'duplicateKafkaEventsPrevented')?.value,
    ).toBeNull();
    // Everything derived from PostgreSQL still answers: one soft dependency must not blank a page.
    expect(body.counters.find((counter) => counter.name === 'outboxEventsPending')?.value).toBe(0);

    await app.close();
  });

  it('renders presence entries as the socket server wrote them', async () => {
    const entry: PresenceEntry = {
      terminalId: 'pos-1',
      restaurantId: DEMO_RESTAURANT,
      role: 'pos',
      source: 'socket',
      socketId: 'socket-1',
      pendingCount: 3,
      offline: true,
      lastSeenAt: new Date().toISOString(),
    };
    const app = buildApp({
      db: db(),
      logLevel: 'silent',
      presence: {
        touch: async () => undefined,
        forget: async () => undefined,
        list: async () => [entry],
      },
      socketGauge: () => 2,
    });

    const body = (
      await app.inject({ method: 'GET', url: '/api/debug/metrics' })
    ).json<MetricsResponse>();

    expect(body.terminals).toEqual([entry]);
    expect(body.presenceError).toBeUndefined();
    expect(
      body.counters.find((counter) => counter.name === 'activeWebSocketConnections')?.value,
    ).toBe(2);

    await app.close();
  });
});
