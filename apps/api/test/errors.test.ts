import { randomUUID } from 'node:crypto';

import type { ApiErrorResponse } from '@pos/contracts';
import { outboxEvents } from '@pos/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { DEMO_RESTAURANT, db, testApp, useTestDatabase } from './helpers.js';

useTestDatabase();

describe('the §17 error envelope', () => {
  it('answers an unknown route with ROUTE_NOT_FOUND rather than Fastify’s own body', async () => {
    const app = testApp();

    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>()).toMatchObject({ code: 'ROUTE_NOT_FOUND' });

    await app.close();
  });

  it('answers a malformed body with 400 VALIDATION_FAILED, not 500', async () => {
    const app = testApp();

    // Fastify rejects this before any route code runs, and it carries its own 400. Answering 500
    // would tell the client its bad request was a server fault — the difference between fixing the
    // payload and retrying it forever (§14).
    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${randomUUID()}/mutations`,
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().code).toBe('VALIDATION_FAILED');

    await app.close();
  });

  it('names the failing field when the body is valid JSON but not a valid mutation', async () => {
    const app = testApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${randomUUID()}/mutations`,
      payload: {
        mutationId: randomUUID(),
        terminalId: 'pos-1',
        restaurantId: DEMO_RESTAURANT,
        type: 'ADD_ITEM',
        baseVersion: 1,
        payload: { productId: 'burger', quantity: 0 },
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<ApiErrorResponse>();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(body.details)).toContain('quantity');

    await app.close();
  });

  it('never leaks a stack trace', async () => {
    const app = testApp();

    const response = await app.inject({ method: 'GET', url: '/api/orders/not-a-uuid' });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('at ');
    expect(response.body).not.toContain('stack');

    await app.close();
  });
});

describe('§20 correlation', () => {
  it('carries the client’s trace id from the request onto the event', async () => {
    const app = testApp();
    const orderId = randomUUID();
    const traceId = 'trace-from-the-pos';

    const response = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/mutations`,
      headers: { 'x-trace-id': traceId },
      payload: {
        mutationId: randomUUID(),
        terminalId: 'pos-1',
        restaurantId: DEMO_RESTAURANT,
        type: 'CREATE_ORDER',
        baseVersion: 0,
        payload: { tableNumber: '9' },
      },
    });

    expect(response.statusCode).toBe(200);

    // One header, followed across three processes: the publisher copies this onto the DomainEvent
    // and both consumers log it (§20).
    const [row] = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, orderId));
    expect(row?.traceId).toBe(traceId);

    await app.close();
  });

  it('falls back to the request id when nothing upstream is tracing', async () => {
    const app = testApp();
    const orderId = randomUUID();

    await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/mutations`,
      headers: { 'x-request-id': 'req-42' },
      payload: {
        mutationId: randomUUID(),
        terminalId: 'pos-1',
        restaurantId: DEMO_RESTAURANT,
        type: 'CREATE_ORDER',
        baseVersion: 0,
        payload: { tableNumber: '9' },
      },
    });

    const [row] = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, orderId));
    expect(row?.traceId).toBe('req-42');

    await app.close();
  });
});

/**
 * The M6 review's P2. Fastify writes `incoming request` — the line carrying the method and the url,
 * the one you reach for first when following a trace — before any `onRequest` hook runs, so binding
 * the correlation fields in a hook left exactly that line without them.
 */
describe('correlation on every line, including the first', () => {
  it('binds requestId and traceId before Fastify logs the incoming request', async () => {
    const lines: Record<string, unknown>[] = [];
    const app = buildApp({
      db: db(),
      logLevel: 'info',
      logDestination: {
        write: (line) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/health/live',
      headers: { 'x-request-id': 'req-7', 'x-trace-id': 'trace-7' },
    });

    const incoming = lines.find((line) => line.msg === 'incoming request');
    expect(incoming).toMatchObject({ requestId: 'req-7', traceId: 'trace-7' });
    // And every other line of that request, not just the first.
    expect(lines.filter((line) => line.reqId === 'req-7').length).toBeGreaterThan(1);
    for (const line of lines.filter((entry) => entry.reqId === 'req-7')) {
      expect(line).toMatchObject({ requestId: 'req-7', traceId: 'trace-7' });
    }

    await app.close();
  });
});
