import type { MutationResponse } from '@pos/contracts';
import type { Db } from '@pos/db';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { SocketGauge } from '../debug/application/ports.js';

const httpLabels = ['method', 'route', 'status_code'] as const;

// Process metrics are module singletons: one Node process owns one set of counters. Registries are
// per app so tests can build several Fastify instances without colliding on metric names.
const httpRequests = new Counter({
  name: 'pos_api_http_requests_total',
  help: 'HTTP responses completed by the API.',
  labelNames: httpLabels,
  registers: [],
});

const httpDuration = new Histogram({
  name: 'pos_api_http_request_duration_seconds',
  help: 'API request duration in seconds.',
  labelNames: httpLabels,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [],
});

const mutationOutcomes = new Counter({
  name: 'pos_api_mutations_total',
  help: 'Mutation responses by durable consistency outcome.',
  labelNames: ['outcome'] as const,
  registers: [],
});

export function observeHttp(request: FastifyRequest, reply: FastifyReply): void {
  const labels = {
    method: request.method,
    // A route pattern is bounded; the raw URL would create one series per order id.
    route: request.routeOptions.url ?? 'unmatched',
    status_code: String(reply.statusCode),
  };
  httpRequests.inc(labels);
  httpDuration.observe(labels, reply.elapsedTime / 1_000);
}

export function observeMutation(outcome: MutationResponse['status']): void {
  mutationOutcomes.inc({ outcome });
}

interface DeliveryRow extends Record<string, unknown> {
  outbox_unpublished: string;
  outbox_dead_lettered: string;
  oldest_unpublished_age_seconds: string | null;
  print_pending: string;
  print_failed: string;
  print_dead_lettered: string;
}

async function readDeliveryState(db: Db): Promise<DeliveryRow> {
  const result = await db.execute<DeliveryRow>(sql`
    select
      (select count(*) from outbox_events
        where published_at is null and dead_lettered_at is null) as outbox_unpublished,
      (select count(*) from outbox_events where dead_lettered_at is not null) as outbox_dead_lettered,
      (select extract(epoch from now() - min(created_at))
        from outbox_events
        where published_at is null and dead_lettered_at is null) as oldest_unpublished_age_seconds,
      (select count(*) from print_jobs where state = 'PENDING') as print_pending,
      (select count(*) from print_jobs where state = 'FAILED') as print_failed,
      (select count(*) from print_jobs where state = 'DEAD_LETTER') as print_dead_lettered
  `);

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('the delivery metrics query returned no row');
  }
  return row;
}

export function createPrometheusRegistry(db: Db, socketGauge?: SocketGauge | undefined): Registry {
  const registry = new Registry();
  registry.registerMetric(httpRequests);
  registry.registerMetric(httpDuration);
  registry.registerMetric(mutationOutcomes);

  new Gauge({
    name: 'pos_api_websocket_connections',
    help: 'Socket.IO connections held by this API instance.',
    registers: [registry],
    collect() {
      this.set(socketGauge?.() ?? 0);
    },
  });

  let pendingRead: Promise<DeliveryRow> | undefined;
  const deliveryState = (): Promise<DeliveryRow> => {
    // Both gauges collect in the same scrape. Share its one database query and forget it once the
    // collection turn is over; normal requests never touch this path.
    pendingRead ??= readDeliveryState(db).finally(() => {
      pendingRead = undefined;
    });
    return pendingRead;
  };

  new Gauge({
    name: 'pos_delivery_items',
    help: 'Current items in actionable delivery states.',
    labelNames: ['pipeline', 'state'] as const,
    registers: [registry],
    async collect() {
      const state = await deliveryState();
      this.set({ pipeline: 'outbox', state: 'unpublished' }, Number(state.outbox_unpublished));
      this.set({ pipeline: 'outbox', state: 'dead_lettered' }, Number(state.outbox_dead_lettered));
      this.set({ pipeline: 'print', state: 'pending' }, Number(state.print_pending));
      this.set({ pipeline: 'print', state: 'failed' }, Number(state.print_failed));
      this.set({ pipeline: 'print', state: 'dead_lettered' }, Number(state.print_dead_lettered));
    },
  });

  new Gauge({
    name: 'pos_outbox_oldest_unpublished_age_seconds',
    help: 'Age of the oldest unpublished, non-dead-lettered outbox event.',
    registers: [registry],
    async collect() {
      const state = await deliveryState();
      this.set(Number(state.oldest_unpublished_age_seconds ?? 0));
    },
  });

  return registry;
}
