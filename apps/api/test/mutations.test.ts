import { randomUUID } from 'node:crypto';

import { conflictLog, orderItems, orders, outboxEvents } from '@pos/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  applyMutation,
  type MutationInput,
  type MutationOutcome,
} from '../src/modules/orders/application/mutation-handler.js';
import { DEMO_RESTAURANT, SECOND_RESTAURANT, db, testApp, useTestDatabase } from './helpers.js';

useTestDatabase();

function mutation(overrides: Partial<MutationInput> & Pick<MutationInput, 'orderId' | 'type'>) {
  return {
    mutationId: randomUUID(),
    terminalId: 'pos-1',
    restaurantId: DEMO_RESTAURANT,
    baseVersion: 1,
    payload: {},
    ...overrides,
  } satisfies MutationInput;
}

async function createOrder(orderId: string, tableNumber = '12'): Promise<MutationOutcome> {
  return applyMutation(
    db(),
    mutation({ orderId, type: 'CREATE_ORDER', baseVersion: 0, payload: { tableNumber } }),
  );
}

async function outboxRows(orderId: string) {
  return db().select().from(outboxEvents).where(eq(outboxEvents.aggregateId, orderId));
}

async function itemRows(orderId: string) {
  return db().select().from(orderItems).where(eq(orderItems.orderId, orderId));
}

describe('§21.1 optimistic concurrency', () => {
  it('lets exactly one of two mutations at the same baseVersion win', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);

    const [first, second] = await Promise.all([
      applyMutation(
        db(),
        mutation({ orderId, type: 'ADD_ITEM', payload: { productId: 'burger', quantity: 1 } }),
      ),
      applyMutation(
        db(),
        mutation({ orderId, type: 'ADD_ITEM', payload: { productId: 'cola', quantity: 1 } }),
      ),
    ]);

    const outcomes = [first.body.status, second.body.status].sort();
    expect(outcomes).toEqual(['APPLIED', 'CONFLICT']);

    const conflict = [first, second].find((result) => result.body.status === 'CONFLICT');
    expect(conflict?.httpStatus).toBe(409);
    expect(conflict?.body).toMatchObject({
      reason: 'ORDER_VERSION_CONFLICT',
      clientBaseVersion: 1,
      serverVersion: 2,
    });

    const [order] = await db().select().from(orders).where(eq(orders.id, orderId));
    expect(order?.version).toBe(2);
    expect(await itemRows(orderId)).toHaveLength(1);
  });
});

describe('§21.2 duplicate mutation', () => {
  it('applies the business effect exactly once', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);

    const input = mutation({
      orderId,
      type: 'ADD_ITEM',
      payload: { productId: 'burger', quantity: 2 },
    });

    const first = await applyMutation(db(), input);
    const second = await applyMutation(db(), input);

    expect(first.body.status).toBe('APPLIED');
    expect(second.body.status).toBe('ALREADY_APPLIED');
    expect(second.httpStatus).toBe(200);

    const items = await itemRows(orderId);
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(2);

    const added = (await outboxRows(orderId)).filter((row) => row.eventType === 'OrderItemAdded');
    expect(added).toHaveLength(1);
  });

  it('serialises two concurrent retries of the same mutation into one effect', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);

    const input = mutation({
      orderId,
      type: 'ADD_ITEM',
      payload: { productId: 'burger', quantity: 1 },
    });

    const results = await Promise.all([applyMutation(db(), input), applyMutation(db(), input)]);

    expect(results.map((result) => result.body.status).sort()).toEqual([
      'ALREADY_APPLIED',
      'APPLIED',
    ]);

    const items = await itemRows(orderId);
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(1);
  });
});

describe('§21.3 mutation id reuse', () => {
  it('rejects a reused id carrying a different payload and keeps the original effect', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);

    const mutationId = randomUUID();
    await applyMutation(
      db(),
      mutation({
        orderId,
        mutationId,
        type: 'ADD_ITEM',
        payload: { productId: 'burger', quantity: 1 },
      }),
    );

    const reused = await applyMutation(
      db(),
      mutation({
        orderId,
        mutationId,
        type: 'ADD_ITEM',
        baseVersion: 2,
        payload: { productId: 'pizza', quantity: 3 },
      }),
    );

    expect(reused.httpStatus).toBe(409);
    expect(reused.body).toEqual({ status: 'MUTATION_ID_REUSED', reason: 'PAYLOAD_MISMATCH' });

    const items = await itemRows(orderId);
    expect(items).toHaveLength(1);
    expect(items[0]?.productId).toBe('burger');
    expect(
      (await outboxRows(orderId)).filter((row) => row.eventType === 'OrderItemAdded'),
    ).toHaveLength(1);
  });
});

describe('§21.5 outbox atomicity', () => {
  it('writes the order change and the event together, or neither', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);

    const applied = await applyMutation(
      db(),
      mutation({ orderId, type: 'ADD_ITEM', payload: { productId: 'burger', quantity: 1 } }),
    );
    expect(applied.body.status).toBe('APPLIED');

    const afterSuccess = await outboxRows(orderId);
    expect(afterSuccess.map((row) => row.eventType)).toEqual(['OrderCreated', 'OrderItemAdded']);
    expect(afterSuccess.every((row) => row.publishedAt === null)).toBe(true);

    // A stale baseVersion: the transaction must leave nothing behind.
    const conflicted = await applyMutation(
      db(),
      mutation({
        orderId,
        type: 'ADD_ITEM',
        baseVersion: 1,
        payload: { productId: 'pizza', quantity: 1 },
      }),
    );

    expect(conflicted.body.status).toBe('CONFLICT');
    expect(await outboxRows(orderId)).toHaveLength(2);
    expect(await itemRows(orderId)).toHaveLength(1);

    const [order] = await db().select().from(orders).where(eq(orders.id, orderId));
    expect(order?.version).toBe(2);

    const conflicts = await db().select().from(conflictLog).where(eq(conflictLog.orderId, orderId));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.serverVersion).toBe(2);
  });
});

describe('§21.11 cross-tenant mutation', () => {
  it('rejects with 403 and changes nothing', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);

    const app = testApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/orders/${orderId}/mutations`,
        payload: {
          mutationId: randomUUID(),
          terminalId: 'pos-3',
          restaurantId: SECOND_RESTAURANT,
          baseVersion: 1,
          type: 'ADD_ITEM',
          payload: { productId: 'burger', quantity: 1 },
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        status: 'REJECTED',
        reason: 'CROSS_TENANT_MUTATION',
      });
    } finally {
      await app.close();
    }

    const [order] = await db().select().from(orders).where(eq(orders.id, orderId));
    expect(order?.version).toBe(1);
    expect(await itemRows(orderId)).toHaveLength(0);
    expect(await outboxRows(orderId)).toHaveLength(1);
    expect(
      await db().select().from(conflictLog).where(eq(conflictLog.orderId, orderId)),
    ).toHaveLength(0);
  });
});

describe('§21.15 order creation idempotency', () => {
  it('returns ALREADY_APPLIED for the same mutation and creates one order', async () => {
    const orderId = randomUUID();
    const input = mutation({
      orderId,
      type: 'CREATE_ORDER',
      baseVersion: 0,
      payload: { tableNumber: '12' },
    });

    const first = await applyMutation(db(), input);
    const second = await applyMutation(db(), input);

    expect(first.body.status).toBe('APPLIED');
    expect(second.body.status).toBe('ALREADY_APPLIED');
    expect(await db().select().from(orders).where(eq(orders.id, orderId))).toHaveLength(1);
  });

  it('returns the existing order for a new mutation id with identical content', async () => {
    const orderId = randomUUID();
    await createOrder(orderId, '12');

    const again = await createOrder(orderId, '12');

    expect(again.httpStatus).toBe(200);
    expect(again.body.status).toBe('ALREADY_APPLIED');
    expect(await db().select().from(orders).where(eq(orders.id, orderId))).toHaveLength(1);
    expect(await outboxRows(orderId)).toHaveLength(1);
  });

  it('conflicts when the same order id arrives with different content', async () => {
    const orderId = randomUUID();
    await createOrder(orderId, '12');

    const different = await createOrder(orderId, '13');

    expect(different.httpStatus).toBe(409);
    expect(different.body).toMatchObject({
      status: 'CONFLICT',
      reason: 'ORDER_ALREADY_EXISTS',
    });
  });
});

describe('the mutation route', () => {
  it('creates an order through HTTP and reports the server version', async () => {
    const orderId = randomUUID();
    const app = testApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/orders/${orderId}/mutations`,
        payload: {
          mutationId: randomUUID(),
          terminalId: 'pos-1',
          restaurantId: DEMO_RESTAURANT,
          baseVersion: 0,
          type: 'CREATE_ORDER',
          payload: { tableNumber: '7' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'APPLIED', serverVersion: 1 });

      const invalid = await app.inject({
        method: 'POST',
        url: `/api/orders/${orderId}/mutations`,
        payload: { mutationId: 'not-a-uuid', type: 'ADD_ITEM' },
      });

      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    } finally {
      await app.close();
    }
  });
});

describe('races the review found', () => {
  it('answers MUTATION_ID_REUSED when a concurrent mutation reuses the id with other content', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);

    const mutationId = randomUUID();
    const results = await Promise.all([
      applyMutation(
        db(),
        mutation({
          orderId,
          mutationId,
          type: 'ADD_ITEM',
          payload: { productId: 'burger', quantity: 1 },
        }),
      ),
      applyMutation(
        db(),
        mutation({
          orderId,
          mutationId,
          type: 'ADD_ITEM',
          payload: { productId: 'pizza', quantity: 5 },
        }),
      ),
    ]);

    // One of the two applied; the other must never be handed the winner's result.
    expect(results.map((result) => result.body.status).sort()).toEqual([
      'APPLIED',
      'MUTATION_ID_REUSED',
    ]);

    const items = await itemRows(orderId);
    expect(items).toHaveLength(1);
    expect(
      (await outboxRows(orderId)).filter((row) => row.eventType === 'OrderItemAdded'),
    ).toHaveLength(1);
  });

  it('rejects an id reused across two orders, where only the primary key can catch it', async () => {
    const mutationId = randomUUID();
    const firstOrder = randomUUID();
    const secondOrder = randomUUID();

    // Different orders, so neither mutation can lose on a version check: the loser can only be
    // stopped by the processed_mutations primary key.
    const results = await Promise.all([
      applyMutation(
        db(),
        mutation({
          orderId: firstOrder,
          mutationId,
          type: 'CREATE_ORDER',
          baseVersion: 0,
          payload: { tableNumber: '21' },
        }),
      ),
      applyMutation(
        db(),
        mutation({
          orderId: secondOrder,
          mutationId,
          type: 'CREATE_ORDER',
          baseVersion: 0,
          payload: { tableNumber: '22' },
        }),
      ),
    ]);

    expect(results.map((result) => result.body.status).sort()).toEqual([
      'APPLIED',
      'MUTATION_ID_REUSED',
    ]);

    const stored = await db().select().from(orders);
    const created = stored.filter((row) => row.id === firstOrder || row.id === secondOrder);
    expect(created).toHaveLength(1);
  });

  it('does not hand a concurrent CREATE_ORDER from another restaurant the winner order', async () => {
    const orderId = randomUUID();

    const results = await Promise.all([
      applyMutation(
        db(),
        mutation({
          orderId,
          type: 'CREATE_ORDER',
          baseVersion: 0,
          payload: { tableNumber: '12' },
        }),
      ),
      applyMutation(
        db(),
        mutation({
          orderId,
          type: 'CREATE_ORDER',
          baseVersion: 0,
          terminalId: 'pos-3',
          restaurantId: SECOND_RESTAURANT,
          payload: { tableNumber: '12' },
        }),
      ),
    ]);

    const statuses = results.map((result) => result.body.status).sort();
    expect(statuses).toEqual(['APPLIED', 'REJECTED']);

    const rejected = results.find((result) => result.body.status === 'REJECTED');
    expect(rejected?.httpStatus).toBe(403);
    expect(rejected?.body).toEqual({ status: 'REJECTED', reason: 'CROSS_TENANT_MUTATION' });

    // Either restaurant may win the insert; what matters is that the loser is told to go away
    // rather than being handed the winner's order.
    const applied = results.find((result) => result.body.status === 'APPLIED');
    const winner = applied?.body.status === 'APPLIED' ? applied.body.order.restaurantId : undefined;

    const stored = await db().select().from(orders).where(eq(orders.id, orderId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.restaurantId).toBe(winner);
  });
});
