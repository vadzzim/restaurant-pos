import { randomUUID } from 'node:crypto';

import { outboxEvents, printJobs } from '@pos/db';
import { describe, expect, it } from 'vitest';

import { DEMO_RESTAURANT, db, testApp, useTestDatabase } from './helpers.js';

useTestDatabase();

describe('GET /metrics', () => {
  it('exports bounded HTTP and mutation labels plus delivery state from PostgreSQL', async () => {
    const app = testApp();
    const orderId = randomUUID();
    const mutationId = randomUUID();
    const create = {
      mutationId,
      terminalId: 'pos-1',
      restaurantId: DEMO_RESTAURANT,
      baseVersion: 0,
      type: 'CREATE_ORDER',
      payload: { tableNumber: 'metrics' },
    };

    await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/mutations`,
      payload: create,
    });
    await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/mutations`,
      payload: create,
    });

    await db().insert(outboxEvents).values({
      id: randomUUID(),
      aggregateId: orderId,
      aggregateType: 'order',
      restaurantId: DEMO_RESTAURANT,
      eventType: 'OrderCreated',
      eventVersion: 99,
      payload: {},
      deadLetteredAt: new Date(),
    });
    await db().insert(printJobs).values({
      id: randomUUID(),
      orderId,
      restaurantId: DEMO_RESTAURANT,
      ticketHash: 'metrics-dead-letter',
      state: 'DEAD_LETTER',
    });

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    const body = response.body;

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(body).toContain('pos_api_mutations_total{outcome="ALREADY_APPLIED"}');
    expect(body).toContain(
      'pos_api_http_requests_total{method="POST",route="/api/orders/:orderId/mutations",status_code="200"}',
    );
    expect(body).toContain('pos_delivery_items{pipeline="outbox",state="unpublished"} 1');
    expect(body).toContain('pos_delivery_items{pipeline="outbox",state="dead_lettered"} 1');
    expect(body).toContain('pos_delivery_items{pipeline="print",state="dead_lettered"} 1');
    expect(body).toMatch(/pos_outbox_oldest_unpublished_age_seconds \d/);
    expect(body).not.toContain(orderId);

    await app.close();
  });
});
