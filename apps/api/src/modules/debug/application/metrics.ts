import { SHARED_COUNTER_NAMES, type CounterReading, type MetricsResponse } from '@pos/contracts';
import type { Db } from '@pos/db';

import { readCounters } from './counters.js';
import { readConsumedByConsumer, readDatabaseCounters } from './debug-queries.js';
import type { PresenceStore, SharedCounterStore, SocketGauge } from './ports.js';

export interface MetricsDeps {
  db: Db;
  socketGauge?: SocketGauge | undefined;
  presence?: PresenceStore | undefined;
  sharedCounters?: SharedCounterStore | undefined;
}

/**
 * §20's counter list, assembled once, each reading carrying where it came from.
 *
 * The ordering of this array is the ordering on screen, and it is the request path: a request
 * arrives, becomes a mutation, becomes an outbox row, becomes a Kafka event, becomes a printed
 * ticket. Reading top to bottom is following one order through the system, which is the whole
 * reason this page exists.
 */
export async function collectMetrics(deps: MetricsDeps): Promise<MetricsResponse> {
  const process_ = readCounters();

  // Three independent reads, and each failure mode is different. Postgres failing is a real error
  // and propagates — `/debug/metrics` has nothing to say without it. Redis failing is expected and
  // is *reported*: `null` readings and a message, never zeros.
  const [database, byConsumer, shared, terminals] = await Promise.all([
    readDatabaseCounters(deps.db),
    readConsumedByConsumer(deps.db),
    deps.sharedCounters?.read().catch(() => null) ?? Promise.resolve(null),
    deps.presence?.list().catch((error: unknown) => error) ?? Promise.resolve([]),
  ]);

  const presenceFailed = !Array.isArray(terminals);

  const counters: CounterReading[] = [
    { name: 'apiRequests', value: process_.apiRequests, source: 'process' },
    { name: 'apiErrors', value: process_.apiErrors, source: 'process', note: 'responses >= 400' },
    {
      name: 'activeWebSocketConnections',
      value: deps.socketGauge?.() ?? null,
      source: 'process',
      note: 'sockets held by this instance only',
    },
    { name: 'mutationsReceived', value: process_.mutationsReceived, source: 'process' },
    { name: 'mutationsApplied', value: process_.mutationsApplied, source: 'process' },
    {
      name: 'duplicateMutationsPrevented',
      value: process_.duplicateMutationsPrevented,
      source: 'process',
      note: '§9: a repeated mutationId answered from processed_mutations',
    },
    {
      name: 'mutationIdReuseRejected',
      value: process_.mutationIdReuseRejected,
      source: 'process',
      note: 'same mutationId, different payload',
    },
    { name: 'crossTenantRejections', value: process_.crossTenantRejections, source: 'process' },
    {
      name: 'realtimeEventsBroadcast',
      value: process_.realtimeEventsBroadcast,
      source: 'process',
      note: 'events this instance fanned out over Socket.IO',
    },

    {
      name: 'processedMutations',
      value: database.processedMutations,
      source: 'database',
      note: 'rows in processed_mutations — the idempotency ledger',
    },
    { name: 'conflictsDetected', value: database.conflictsDetected, source: 'database' },
    {
      name: 'blockedMutations',
      value: database.blockedMutations,
      source: 'database',
      note: 'conflicts with no resolution: a client queue still halted (§14.1)',
    },
    { name: 'outboxEventsPending', value: database.outboxPending, source: 'database' },
    { name: 'outboxEventsPublished', value: database.outboxPublished, source: 'database' },
    { name: 'outboxEventsDeadLettered', value: database.outboxDeadLettered, source: 'database' },
    {
      name: 'kafkaEventsConsumed',
      value: database.kafkaEventsConsumed,
      source: 'database',
      note: `unique events recorded per consumer — ${describeConsumers(byConsumer)}`,
    },
    {
      name: 'printJobsPending',
      value: database.printJobsPending,
      source: 'database',
      note: 'gauge: rows waiting on a first attempt',
    },
    {
      name: 'printJobsSucceeded',
      value: database.printJobsPrinted,
      source: 'database',
      note: 'the device accepted the ticket; §12.3 is at-least-once, so a duplicate may have printed',
    },
    {
      name: 'printJobsFailed',
      value: database.printJobsFailed,
      source: 'database',
      note: 'gauge, not a total: rows whose last attempt failed and that BullMQ is still retrying',
    },
    { name: 'printJobsDeadLettered', value: database.printJobsDeadLettered, source: 'database' },

    ...SHARED_COUNTER_NAMES.map((name): CounterReading => ({
      name,
      value: shared === null ? null : shared[name],
      source: 'shared',
      note: 'counted by both consumers in Redis; null means Redis could not be read',
    })),
  ];

  return {
    counters,
    terminals: presenceFailed ? [] : terminals,
    ...(presenceFailed
      ? { presenceError: describeError(terminals) }
      : deps.presence === undefined
        ? { presenceError: 'presence is not configured on this instance' }
        : {}),
    processUptimeSeconds: Math.round(process.uptime()),
  };
}

function describeConsumers(byConsumer: { consumer: string; count: number }[]): string {
  if (byConsumer.length === 0) {
    return 'no consumer has recorded an event yet';
  }
  return byConsumer.map(({ consumer, count }) => `${consumer}: ${count}`).join(', ');
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
