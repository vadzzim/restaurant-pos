import type {
  DependenciesResponse,
  DependencyReport,
  HealthStatus,
  LivenessResponse,
  ReadinessResponse,
} from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';

import {
  postgresProbe,
  readOutboxBacklog,
  runProbe,
  type DependencyProbe,
} from '../application/dependency-probes.js';

export interface HealthRouteOptions {
  db: Db;
  /**
   * The complete dependency list. It defaults to PostgreSQL alone, which is what `buildApp()` is
   * for: an injected test app needs neither Redis nor a broker (ADR 006). `index.ts` passes all
   * three, and a test can pass a deliberately failing probe to assert a degradation branch.
   */
  probes?: DependencyProbe[] | undefined;
  timeoutMs?: number | undefined;
}

function overallStatus(reports: DependencyReport[]): HealthStatus {
  if (reports.some((report) => report.kind === 'hard' && report.status === 'down')) {
    return 'unavailable';
  }
  if (reports.some((report) => report.status === 'down')) {
    return 'degraded';
  }
  return 'ok';
}

/**
 * The three-way split of §17. The reasoning — above all why the broker being down is not an
 * unreadiness — is in `docs/adr/011-health-and-degradation.md`.
 */
export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  const { db, probes = [postgresProbe(db)], timeoutMs = 2_000 } = options;
  const hard = probes.filter((probe) => probe.kind === 'hard');

  // A readiness probe with nothing to check would answer 200 forever and quietly keep a broken
  // instance in the load balancer. Failing at boot is the cheapest moment to learn about it.
  if (hard.length === 0) {
    throw new Error('registerHealthRoutes needs at least one hard dependency to check readiness');
  }

  /**
   * Liveness answers whether the process is running and touches nothing else. A liveness probe
   * that consulted a dependency would restart a healthy API because the database blinked, turning
   * one outage into two.
   */
  app.get('/api/health/live', async (): Promise<LivenessResponse> => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  /**
   * Readiness answers one question — can this instance accept a write? — and therefore checks the
   * hard dependencies, which is PostgreSQL and nothing else (§17). It answers 503 when it cannot,
   * because a probe that only ever returns 200 is not a probe.
   *
   * The body shape is the same on 200 and 503 on purpose: whoever reads a failing probe needs to
   * see *which* check failed and how long it took, and an error envelope would tell them neither.
   */
  app.get('/api/health/ready', async (_request, reply): Promise<ReadinessResponse> => {
    const checks = await Promise.all(hard.map((probe) => runProbe(probe, timeoutMs)));
    const ready = checks.every((check) => check.status === 'up');

    reply.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks };
  });

  /**
   * The informational third leg (§16, §17): everything readiness deliberately ignores, graded hard
   * against soft, plus the outbox backlog that puts a number on a broker outage.
   *
   * Consumer lag is not here. It needs a Kafka admin describing group offsets and it belongs with
   * §20's other counters in M11; guessing at it would be worse than its absence.
   */
  app.get('/api/debug/dependencies', async (): Promise<DependenciesResponse> => {
    const [dependencies, outbox] = await Promise.all([
      Promise.all(probes.map((probe) => runProbe(probe, timeoutMs))),
      // The backlog is a second read of the hard dependency. If PostgreSQL is down this fails too,
      // and an empty backlog next to `postgres: down` is the honest answer.
      readOutboxBacklog(db).catch(() => ({
        pending: 0,
        deadLettered: 0,
        oldestPendingAgeSeconds: null,
      })),
    ]);

    return { status: overallStatus(dependencies), dependencies, outbox };
  });
}
