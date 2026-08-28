import { randomUUID } from 'node:crypto';

import type { DependenciesResponse, LivenessResponse, ReadinessResponse } from '@pos/contracts';
import { outboxEvents } from '@pos/db';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  postgresProbe,
  type DependencyProbe,
} from '../src/modules/health/application/dependency-probes.js';
import { db, testApp, useTestDatabase } from './helpers.js';

useTestDatabase();

function downProbe(name: string, kind: 'hard' | 'soft'): DependencyProbe {
  return {
    name,
    kind,
    impact: 'test',
    check: async () => {
      throw new Error(`${name} is unreachable`);
    },
  };
}

function upProbe(name: string, kind: 'hard' | 'soft'): DependencyProbe {
  return { name, kind, impact: 'test', check: async () => undefined };
}

function appWith(probes: DependencyProbe[]): ReturnType<typeof buildApp> {
  return buildApp({ db: db(), logLevel: 'silent', probes, healthTimeoutMs: 1_000 });
}

describe('GET /api/health/live', () => {
  it('answers ok without touching any dependency', async () => {
    // Every dependency is failing, including the hard one. Liveness must not care: restarting a
    // healthy process because the database blinked turns one outage into two.
    const app = appWith([downProbe('postgres', 'hard')]);

    const response = await app.inject({ method: 'GET', url: '/api/health/live' });

    expect(response.statusCode).toBe(200);
    const body = response.json<LivenessResponse>();
    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    await app.close();
  });
});

describe('GET /api/health/ready', () => {
  it('is green against a live database', async () => {
    const app = testApp();

    const response = await app.inject({ method: 'GET', url: '/api/health/ready' });

    expect(response.statusCode).toBe(200);
    const body = response.json<ReadinessResponse>();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual([expect.objectContaining({ name: 'postgres', status: 'up' })]);

    await app.close();
  });

  it('answers 503 in the same shape when PostgreSQL is down', async () => {
    const app = appWith([downProbe('postgres', 'hard')]);

    const response = await app.inject({ method: 'GET', url: '/api/health/ready' });

    expect(response.statusCode).toBe(503);
    const body = response.json<ReadinessResponse>();
    expect(body.status).toBe('unavailable');
    expect(body.checks[0]).toMatchObject({ name: 'postgres', kind: 'hard', status: 'down' });
    // A failing probe still names its check, so the shape carries information rather than a code.
    expect(body.checks[0]?.error).toContain('unreachable');

    await app.close();
  });

  it('ignores the soft dependencies entirely — a broker outage must not take a POS offline', async () => {
    const app = appWith([
      postgresProbe(db()),
      downProbe('redpanda', 'soft'),
      downProbe('redis', 'soft'),
    ]);

    const response = await app.inject({ method: 'GET', url: '/api/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json<ReadinessResponse>().checks).toHaveLength(1);

    await app.close();
  });
});

describe('GET /api/debug/dependencies', () => {
  it('grades a soft outage as degraded and a hard one as unavailable', async () => {
    const degraded = appWith([postgresProbe(db()), downProbe('redpanda', 'soft')]);
    const degradedBody = (
      await degraded.inject({ method: 'GET', url: '/api/debug/dependencies' })
    ).json<DependenciesResponse>();

    expect(degradedBody.status).toBe('degraded');
    expect(degradedBody.dependencies.map((entry) => entry.name)).toEqual(['postgres', 'redpanda']);
    await degraded.close();

    const broken = appWith([downProbe('postgres', 'hard'), upProbe('redpanda', 'soft')]);
    const brokenBody = (
      await broken.inject({ method: 'GET', url: '/api/debug/dependencies' })
    ).json<DependenciesResponse>();

    expect(brokenBody.status).toBe('unavailable');
    await broken.close();
  });

  it('reports the outbox backlog, which is what a broker outage costs', async () => {
    await db().insert(outboxEvents).values({
      id: randomUUID(),
      aggregateId: randomUUID(),
      aggregateType: 'order',
      restaurantId: 'demo-restaurant',
      eventType: 'OrderItemAdded',
      eventVersion: 2,
      payload: {},
    });

    const app = testApp();
    const body = (
      await app.inject({ method: 'GET', url: '/api/debug/dependencies' })
    ).json<DependenciesResponse>();

    expect(body.status).toBe('ok');
    expect(body.outbox.pending).toBe(1);
    expect(body.outbox.deadLettered).toBe(0);
    expect(body.outbox.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);

    await app.close();
  });
});
