import { randomUUID } from 'node:crypto';

import {
  conflictLog,
  orderItems,
  orders,
  outboxEvents,
  payments,
  processedMutations,
} from '@pos/db';
import { eq, sql } from 'drizzle-orm';
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

/** Walk an order forward one mutation at a time, asserting the version the server reports. */
async function step(
  orderId: string,
  type: MutationInput['type'],
  baseVersion: number,
  payload: MutationInput['payload'] = {},
): Promise<MutationOutcome> {
  return applyMutation(db(), mutation({ orderId, type, baseVersion, payload }));
}

function appliedOrder(outcome: MutationOutcome) {
  if (outcome.body.status !== 'APPLIED') {
    throw new Error(`expected APPLIED, got ${outcome.body.status}`);
  }
  return outcome.body.order;
}

describe('§21.4 cancelled-order conflict', () => {
  it('answers ORDER_CANCELLED rather than a version conflict, though both are true', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 1 });
    await step(orderId, 'ADD_ITEM', 2, { productId: 'cola', quantity: 1 });
    await step(orderId, 'ADD_ITEM', 3, { productId: 'pizza', quantity: 1 });
    await step(orderId, 'ADD_ITEM', 4, { productId: 'coffee', quantity: 1 });
    const cancelled = appliedOrder(await step(orderId, 'CANCEL', 5, {}));
    expect(cancelled).toMatchObject({ status: 'CANCELLED', version: 6 });

    // The client is still at v5 and knows nothing about the cancellation.
    const stale = await step(orderId, 'ADD_ITEM', 5, { productId: 'french-fries', quantity: 1 });

    expect(stale.httpStatus).toBe(409);
    expect(stale.body).toMatchObject({
      status: 'CONFLICT',
      // Not ORDER_VERSION_CONFLICT: rebasing onto v6 would only be refused again, and for a
      // reason the operator could have been told the first time.
      reason: 'ORDER_CANCELLED',
      clientBaseVersion: 5,
      serverVersion: 6,
    });

    expect(await itemRows(orderId)).toHaveLength(4);
    expect(await outboxRows(orderId)).toHaveLength(6);

    const logged = await db().select().from(conflictLog).where(eq(conflictLog.orderId, orderId));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ serverStatus: 'CANCELLED', clientBaseVersion: 5 });
  });
});

describe('§21.9 payment idempotency', () => {
  it('creates one payment for a mutation submitted twice', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 2 });

    const pay = mutation({ orderId, type: 'PAY', baseVersion: 2, payload: { method: 'CARD' } });
    const first = await applyMutation(db(), pay);
    const second = await applyMutation(db(), pay);

    expect(first.body.status).toBe('APPLIED');
    expect(second.body.status).toBe('ALREADY_APPLIED');
    expect(second.body).toMatchObject({ serverVersion: 3 });

    const rows = await db().select().from(payments).where(eq(payments.orderId, orderId));
    expect(rows).toHaveLength(1);
    // The amount is the order's own total, never a number the client sent.
    expect(rows[0]).toMatchObject({
      amountCents: 2400,
      method: 'CARD',
      mutationId: pay.mutationId,
    });

    const events = await outboxRows(orderId);
    expect(events.filter((event) => event.eventType === 'OrderPaid')).toHaveLength(1);
  });

  it('refuses a second payment arriving as a different mutation', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'cola', quantity: 1 });
    await step(orderId, 'PAY', 2, { method: 'CASH' });

    const again = await step(orderId, 'PAY', 3, { method: 'CASH' });

    expect(again.httpStatus).toBe(409);
    expect(again.body).toMatchObject({ status: 'CONFLICT', reason: 'ORDER_ALREADY_PAID' });
    expect(await db().select().from(payments).where(eq(payments.orderId, orderId))).toHaveLength(1);
  });
});

describe('§21.10 kitchen transition race', () => {
  it('lets one of two MARK_READY mutations at the same baseVersion win', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 1 });
    await step(orderId, 'SEND_TO_KITCHEN', 2);
    await step(orderId, 'START_PREPARING', 3);

    // Two kitchen displays, both looking at the same ticket, both pressing Ready.
    const [first, second] = await Promise.all([
      applyMutation(db(), mutation({ orderId, type: 'MARK_READY', baseVersion: 4 })),
      applyMutation(db(), mutation({ orderId, type: 'MARK_READY', baseVersion: 4 })),
    ]);

    expect([first.body.status, second.body.status].sort()).toEqual(['APPLIED', 'CONFLICT']);

    const [order] = await db().select().from(orders).where(eq(orders.id, orderId));
    expect(order).toMatchObject({ status: 'READY', version: 5 });

    const events = await outboxRows(orderId);
    expect(events.filter((event) => event.eventType === 'OrderReady')).toHaveLength(1);
  });

  it('refuses a kitchen transition taken out of order', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 1 });
    await step(orderId, 'SEND_TO_KITCHEN', 2);

    const early = await step(orderId, 'MARK_READY', 3);

    expect(early.httpStatus).toBe(409);
    expect(early.body).toMatchObject({
      status: 'CONFLICT',
      reason: 'INVALID_STATUS_TRANSITION',
      serverVersion: 3,
    });
  });
});

describe('the whole order lifecycle', () => {
  it('walks create -> add -> change -> remove -> kitchen -> ready -> paid', async () => {
    const orderId = randomUUID();
    expect(appliedOrder(await createOrder(orderId))).toMatchObject({
      status: 'OPEN',
      version: 1,
      totalCents: 0,
    });

    expect(
      appliedOrder(await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 2 })),
    ).toMatchObject({ version: 2, totalCents: 2400 });

    expect(
      appliedOrder(await step(orderId, 'ADD_ITEM', 2, { productId: 'cola', quantity: 1 })),
    ).toMatchObject({ version: 3, totalCents: 2700 });

    // An absolute quantity, not a delta: two burgers become one.
    expect(
      appliedOrder(await step(orderId, 'CHANGE_QUANTITY', 3, { productId: 'burger', quantity: 1 })),
    ).toMatchObject({ version: 4, totalCents: 1500 });

    expect(
      appliedOrder(await step(orderId, 'REMOVE_ITEM', 4, { productId: 'cola' })),
    ).toMatchObject({ version: 5, totalCents: 1200 });
    expect(await itemRows(orderId)).toHaveLength(1);

    expect(appliedOrder(await step(orderId, 'SEND_TO_KITCHEN', 5))).toMatchObject({
      status: 'SENT_TO_KITCHEN',
      version: 6,
    });
    expect(appliedOrder(await step(orderId, 'START_PREPARING', 6))).toMatchObject({
      status: 'PREPARING',
      version: 7,
    });
    expect(appliedOrder(await step(orderId, 'MARK_READY', 7))).toMatchObject({
      status: 'READY',
      version: 8,
    });
    expect(appliedOrder(await step(orderId, 'PAY', 8, { method: 'CASH' }))).toMatchObject({
      status: 'PAID',
      version: 9,
      totalCents: 1200,
    });

    const events = await outboxRows(orderId);
    expect(events.map((event) => event.eventVersion).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(new Set(events.map((event) => event.eventType))).toEqual(
      new Set([
        'OrderCreated',
        'OrderItemAdded',
        'OrderQuantityChanged',
        'OrderItemRemoved',
        'OrderSentToKitchen',
        'OrderPreparing',
        'OrderReady',
        'OrderPaid',
      ]),
    );
  });

  it('treats removing a line that is already gone as already applied, without a new version', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 1 });
    await step(orderId, 'REMOVE_ITEM', 2, { productId: 'burger' });

    const again = await step(orderId, 'REMOVE_ITEM', 3, { productId: 'burger' });

    expect(again.httpStatus).toBe(200);
    expect(again.body).toMatchObject({ status: 'ALREADY_APPLIED', serverVersion: 3 });
    expect(await outboxRows(orderId)).toHaveLength(3);
  });

  it('cancels an order twice without moving it', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'CANCEL', 1, {});

    const again = await step(orderId, 'CANCEL', 2, {});

    expect(again.body).toMatchObject({ status: 'ALREADY_APPLIED', serverVersion: 2 });
    expect(await outboxRows(orderId)).toHaveLength(2);
  });
});

describe('the kitchen command endpoints (§17)', () => {
  it('constructs the same mutations the canonical write path would', async () => {
    const app = testApp();
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 1 });
    await step(orderId, 'SEND_TO_KITCHEN', 2);

    const preparing = await app.inject({
      method: 'POST',
      url: `/api/kitchen/orders/${orderId}/preparing`,
      payload: { mutationId: randomUUID(), restaurantId: DEMO_RESTAURANT, baseVersion: 3 },
    });

    expect(preparing.statusCode).toBe(200);
    expect(preparing.json()).toMatchObject({
      status: 'APPLIED',
      serverVersion: 4,
      order: { status: 'PREPARING' },
    });

    const ready = await app.inject({
      method: 'POST',
      url: `/api/kitchen/orders/${orderId}/ready`,
      payload: {
        mutationId: randomUUID(),
        restaurantId: DEMO_RESTAURANT,
        baseVersion: 4,
        terminalId: 'kds-2',
      },
    });

    expect(ready.json()).toMatchObject({ status: 'APPLIED', order: { status: 'READY' } });

    // The default terminal id is what the adapter supplies when a display does not name itself.
    const processed = await db()
      .select()
      .from(processedMutations)
      .where(eq(processedMutations.orderId, orderId));
    expect(processed.map((row) => row.terminalId)).toContain('kitchen-display');
    expect(processed.map((row) => row.terminalId)).toContain('kds-2');

    await app.close();
  });

  it('refuses a command carrying another restaurant, like any other mutation', async () => {
    const app = testApp();
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 1 });
    await step(orderId, 'SEND_TO_KITCHEN', 2);

    const response = await app.inject({
      method: 'POST',
      url: `/api/kitchen/orders/${orderId}/preparing`,
      payload: { mutationId: randomUUID(), restaurantId: SECOND_RESTAURANT, baseVersion: 3 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: 'CROSS_TENANT_MUTATION' });

    await app.close();
  });
});

/**
 * Block until some backend in this database is waiting on a lock. The suite runs one file at a
 * time and one test at a time, so the only candidate is the transaction under test.
 *
 * This is what makes the test below deterministic rather than a race that usually passes: if the
 * acknowledgement does not take the lock, nothing ever blocks and this throws.
 */
async function waitUntilBlockedOnLock(): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await db().execute(sql`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `);

    if (Number((result.rows[0] as { waiting: number } | undefined)?.waiting ?? 0) > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('nothing ever blocked on the order row: the acknowledgement is unguarded');
}

describe('the review found: an already-applied answer asserts state it does not write', () => {
  it('refuses to acknowledge a removal that a concurrent addition has undone', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 1 });

    let acquired = (): void => {};
    let release = (): void => {};
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A concurrent ADD_ITEM for the very product the removal is about, held open so it commits
    // inside the window between the removal's decision and the removal's acknowledgement.
    const addingCola = db().transaction(async (tx) => {
      await tx.execute(sql`select 1 from orders where id = ${orderId} for update`);
      acquired();
      await gate;

      await tx.execute(sql`update orders set version = version + 1 where id = ${orderId}`);
      await tx.execute(sql`
        insert into order_items (id, order_id, product_id, name, quantity, unit_price_cents)
        values (${randomUUID()}, ${orderId}, 'cola', 'Cola', 1, 300)
      `);
      await tx.execute(sql`update orders set total_cents = 1500 where id = ${orderId}`);
    });

    await locked;

    // Decided against an order that has no cola, so it rolls back and asks to be acknowledged.
    const removing = applyMutation(
      db(),
      mutation({ orderId, type: 'REMOVE_ITEM', baseVersion: 2, payload: { productId: 'cola' } }),
    );

    // `finally`, because a failure here would otherwise leave the holding transaction waiting on
    // a gate nobody opens, and the suite would hang instead of reporting what went wrong.
    try {
      await waitUntilBlockedOnLock();
    } finally {
      release();
      await addingCola;
    }

    const outcome = await removing;

    // Answering ALREADY_APPLIED here would tell the caller their removal is reflected in a
    // canonical order that visibly still contains the line.
    expect(outcome.httpStatus).toBe(409);
    expect(outcome.body).toMatchObject({
      status: 'CONFLICT',
      reason: 'ORDER_VERSION_CONFLICT',
      clientBaseVersion: 2,
      serverVersion: 3,
    });

    expect((await itemRows(orderId)).map((row) => row.productId).sort()).toEqual([
      'burger',
      'cola',
    ]);
  });

  it('names the domain reason when the world moved for a reason worth naming', async () => {
    const orderId = randomUUID();
    await createOrder(orderId);
    await step(orderId, 'ADD_ITEM', 1, { productId: 'burger', quantity: 1 });

    let acquired = (): void => {};
    let release = (): void => {};
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const cancelling = db().transaction(async (tx) => {
      await tx.execute(sql`select 1 from orders where id = ${orderId} for update`);
      acquired();
      await gate;

      await tx.execute(sql`
        update orders set version = version + 1, status = 'CANCELLED'::order_status
        where id = ${orderId}
      `);
    });

    await locked;

    const removing = applyMutation(
      db(),
      mutation({ orderId, type: 'REMOVE_ITEM', baseVersion: 2, payload: { productId: 'cola' } }),
    );

    try {
      await waitUntilBlockedOnLock();
    } finally {
      release();
      await cancelling;
    }

    expect((await removing).body).toMatchObject({
      status: 'CONFLICT',
      reason: 'ORDER_CANCELLED',
    });
  });
});
