import { randomUUID } from 'node:crypto';

import type { ConfigResponse, KitchenTicket, MenuItem, OrderSnapshot } from '@pos/contracts';
import { featureFlags, kitchenTickets } from '@pos/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { applyMutation } from '../src/modules/orders/application/mutation-handler.js';
import { DEMO_RESTAURANT, SECOND_RESTAURANT, db, testApp, useTestDatabase } from './helpers.js';

useTestDatabase();

async function createOrder(orderId: string, tableNumber = '12'): Promise<void> {
  await applyMutation(db(), {
    orderId,
    mutationId: randomUUID(),
    terminalId: 'pos-1',
    restaurantId: DEMO_RESTAURANT,
    baseVersion: 0,
    type: 'CREATE_ORDER',
    payload: { tableNumber },
  });
}

async function insertTicket(restaurantId: string, tableNumber: string): Promise<string> {
  const orderId = randomUUID();
  await db().insert(kitchenTickets).values({
    orderId,
    restaurantId,
    tableNumber,
    items: [],
    state: 'SENT_TO_KITCHEN',
    sourceEventVersion: 3,
  });
  return orderId;
}

describe('GET /api/menu', () => {
  it('returns the seeded products by name', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'GET', url: '/api/menu' });

    expect(response.statusCode).toBe(200);
    const body = response.json<MenuItem[]>();
    expect(body.length).toBeGreaterThan(0);
    expect(body.map((item) => item.name)).toEqual([...body.map((item) => item.name)].sort());
    expect(body).toContainEqual({ id: 'burger', name: 'Burger', priceCents: 1200 });

    await app.close();
  });
});

describe('GET /api/orders/:orderId', () => {
  it('returns the canonical snapshot the client refetches on reconnect', async () => {
    const orderId = randomUUID();
    await createOrder(orderId, '7');

    const app = testApp();
    const response = await app.inject({ method: 'GET', url: `/api/orders/${orderId}` });

    expect(response.statusCode).toBe(200);
    const snapshot = response.json<OrderSnapshot>();
    expect(snapshot.id).toBe(orderId);
    expect(snapshot.tableNumber).toBe('7');
    expect(snapshot.status).toBe('OPEN');
    expect(snapshot.version).toBe(1);
    expect(snapshot.items).toEqual([]);

    await app.close();
  });

  it('answers 404 ORDER_NOT_FOUND for an unknown order', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'GET', url: `/api/orders/${randomUUID()}` });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('ORDER_NOT_FOUND');

    await app.close();
  });
});

describe('GET /api/kitchen/tickets', () => {
  it('returns only the requested restaurant tickets', async () => {
    const mine = await insertTicket(DEMO_RESTAURANT, '12');
    await insertTicket(SECOND_RESTAURANT, '99');

    const app = testApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/kitchen/tickets?restaurantId=${DEMO_RESTAURANT}`,
    });

    expect(response.statusCode).toBe(200);
    const tickets = response.json<KitchenTicket[]>();
    expect(tickets.map((ticket) => ticket.orderId)).toEqual([mine]);
    expect(tickets[0]?.sourceEventVersion).toBe(3);

    await app.close();
  });

  it('rejects a request with no restaurantId', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'GET', url: '/api/kitchen/tickets' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED');

    await app.close();
  });
});

describe('GET /api/orders/:orderId under concurrent writes', () => {
  it('never returns a total that disagrees with the items it returned', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);

    const app = testApp();
    const products = ['burger', 'cola', 'pizza', 'coffee', 'french-fries'];

    // The snapshot is two SELECTs. Read at READ COMMITTED they can straddle a commit and return
    // one version's header with another version's items. This asserts the invariant that makes
    // that visible — it does not force the interleaving, so it can only fail truthfully.
    for (const productId of products) {
      const [, response] = await Promise.all([
        applyMutation(db(), {
          orderId,
          mutationId: randomUUID(),
          terminalId: 'pos-1',
          restaurantId: DEMO_RESTAURANT,
          baseVersion: (
            await app.inject({ method: 'GET', url: `/api/orders/${orderId}` })
          ).json<OrderSnapshot>().version,
          type: 'ADD_ITEM',
          payload: { productId, quantity: 2 },
        }),
        app.inject({ method: 'GET', url: `/api/orders/${orderId}` }),
      ]);

      const snapshot = response.json<OrderSnapshot>();
      const summed = snapshot.items.reduce(
        (total, item) => total + item.quantity * item.unitPriceCents,
        0,
      );
      expect(summed).toBe(snapshot.totalCents);
    }

    await app.close();
  });
});

describe('GET /api/config', () => {
  it('reflects the feature_flags row', async () => {
    const app = testApp();
    const url = `/api/config?restaurantId=${DEMO_RESTAURANT}`;

    const enabled = await app.inject({ method: 'GET', url });
    expect(enabled.json<ConfigResponse>().flags['realtime.websocket_push']).toBe(true);

    await db()
      .update(featureFlags)
      .set({ enabled: false })
      .where(eq(featureFlags.key, 'realtime.websocket_push'));

    const disabled = await app.inject({ method: 'GET', url });
    expect(disabled.json<ConfigResponse>().flags['realtime.websocket_push']).toBe(false);

    // Reference data is not truncated between tests, so this row has to be put back.
    await db()
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.key, 'realtime.websocket_push'));

    await app.close();
  });
});
