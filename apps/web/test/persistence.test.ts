import type { OrderSnapshot } from '@pos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';

import { db, PENDING_MUTATION_STATUSES, type PendingMutationRecord } from '../src/persistence/db';
import { localStore, persistenceError } from '../src/persistence/local-store';

function snapshot(id: string, version: number): OrderSnapshot {
  return {
    id,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status: 'OPEN',
    version,
    totalCents: 1200,
    items: [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }],
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const pending = (
  overrides: Partial<Omit<PendingMutationRecord, 'createdAt'>> = {},
): Omit<PendingMutationRecord, 'createdAt'> => ({
  mutationId: 'mutation-1',
  restaurantId: 'demo-restaurant',
  terminalId: 'pos-1',
  orderId: 'order-a',
  baseVersion: 3,
  type: 'ADD_ITEM',
  payload: { productId: 'burger', quantity: 1 },
  status: 'PENDING',
  ...overrides,
});

describe('the cached order and the terminal pointer', () => {
  it('comes back for the terminal that cached it', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-a', 4));

    const restored = await localStore.readTerminalState('pos-1');

    expect(restored.order?.id).toBe('order-a');
    expect(restored.order?.version).toBe(4);
    expect(restored.order?.items).toHaveLength(1);
  });

  it('is not visible to another terminal', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-a', 4));

    expect((await localStore.readTerminalState('pos-3')).order).toBeUndefined();
  });

  it('survives a Vue proxy', async () => {
    // IndexedDB clones what it stores and a reactive proxy raises `DataCloneError`. This is the
    // shape every value arrives in, because every value comes out of a store.
    await localStore.saveOrder('pos-1', reactive(snapshot('order-a', 4)));

    expect(persistenceError.value).toBeUndefined();
    expect((await localStore.readTerminalState('pos-1')).order?.version).toBe(4);
  });

  it('keeps the snapshot when the pointer is cleared', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-a', 4));
    await localStore.clearCurrentOrder('pos-1');

    // "New order" is not an answer to "did that mutation apply?" — only the pointer was ever
    // about the screen.
    expect((await localStore.readTerminalState('pos-1')).order).toBeUndefined();
    expect(await db.orders.get('order-a')).toBeDefined();
  });
});

describe('the pending mutation queue', () => {
  it('round-trips an intent with its identity intact', async () => {
    await localStore.savePending(pending({ status: 'SYNCING' }));

    const restored = (await localStore.readTerminalState('pos-1')).pending;

    expect(restored?.mutationId).toBe('mutation-1');
    expect(restored?.baseVersion).toBe(3);
    expect(restored?.type).toBe('ADD_ITEM');
    expect(restored?.status).toBe('SYNCING');
  });

  it('keeps the creation time across a retry rather than moving it to the back of the queue', async () => {
    await localStore.savePending(pending());
    const first = await db.pendingMutations.get('mutation-1');

    await localStore.savePending(pending({ status: 'SYNCING' }));
    const second = await db.pendingMutations.get('mutation-1');

    // §14 syncs in local creation order. A retry is the same intent, so it must not overtake the
    // mutations that were formed after it.
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(await db.pendingMutations.count()).toBe(1);
  });

  it('surfaces the earliest unresolved intent', async () => {
    await localStore.savePending(pending({ mutationId: 'older' }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await localStore.savePending(pending({ mutationId: 'newer' }));

    expect((await localStore.readTerminalState('pos-1')).pending?.mutationId).toBe('older');
  });

  it('is deleted on request', async () => {
    await localStore.savePending(pending());
    await localStore.deletePending('mutation-1');

    expect((await localStore.readTerminalState('pos-1')).pending).toBeUndefined();
  });

  it('changes status without changing anything else', async () => {
    await localStore.savePending(pending({ status: 'SYNCING' }));
    await localStore.setPendingStatus('mutation-1', 'PENDING');

    const row = await db.pendingMutations.get('mutation-1');
    expect(row?.status).toBe('PENDING');
    expect(row?.mutationId).toBe('mutation-1');
    expect(row?.baseVersion).toBe(3);
  });
});

describe('reading the kitchen display back', () => {
  it('sees only the restaurant on screen', async () => {
    // Every kitchen row carries the same terminal id, in every restaurant. The restaurant filter
    // is the only thing standing between this rail and another tenant's commands.
    await localStore.savePending(
      pending({
        mutationId: 'here',
        terminalId: 'kitchen-display',
        restaurantId: 'demo-restaurant',
        type: 'START_PREPARING',
        payload: {},
      }),
    );
    await localStore.savePending(
      pending({
        mutationId: 'elsewhere',
        terminalId: 'kitchen-display',
        restaurantId: 'second-restaurant',
        type: 'START_PREPARING',
        payload: {},
      }),
    );

    const rows = await localStore.readPendingForTerminalInRestaurant(
      'kitchen-display',
      'demo-restaurant',
    );

    expect(rows.map((row) => row.mutationId)).toEqual(['here']);
  });
});

describe('pruning cached orders', () => {
  it('keeps what is referred to and drops what is not', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-pointed-at', 1));
    await localStore.saveOrder('pos-3', snapshot('order-with-a-mutation', 1));
    await localStore.saveOrder('pos-2', snapshot('order-forgotten', 1));

    // pos-2 walked away from its order; pos-3 walked away but left an unresolved mutation on it.
    await localStore.clearCurrentOrder('pos-2');
    await localStore.clearCurrentOrder('pos-3');
    await localStore.savePending(
      pending({ mutationId: 'still-open', terminalId: 'pos-3', orderId: 'order-with-a-mutation' }),
    );

    await localStore.pruneOrders();

    expect(await db.orders.get('order-pointed-at')).toBeDefined();
    expect(await db.orders.get('order-with-a-mutation')).toBeDefined();
    expect(await db.orders.get('order-forgotten')).toBeUndefined();
  });
});

describe('a storage failure cannot break a command', () => {
  it('is reported and swallowed', async () => {
    vi.spyOn(db.pendingMutations, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'));

    await expect(localStore.savePending(pending())).resolves.toBeUndefined();

    expect(persistenceError.value).toMatch(/QuotaExceededError/);
  });

  it('answers a failed read with the neutral value rather than throwing', async () => {
    vi.spyOn(db.syncMetadata, 'get').mockRejectedValueOnce(new Error('database is closed'));

    await expect(localStore.readTerminalState('pos-1')).resolves.toEqual({
      order: undefined,
      pending: undefined,
    });
    expect(persistenceError.value).toMatch(/database is closed/);
  });

  it('stays reported once it has happened, because the write is never retried', async () => {
    vi.spyOn(db.pendingMutations, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await localStore.savePending(pending());
    vi.restoreAllMocks();

    await localStore.savePending(pending({ mutationId: 'mutation-2' }));

    // The device is still one write short of what it promised; a later success does not undo that.
    expect(persistenceError.value).toMatch(/QuotaExceededError/);
  });
});

describe('the §14 status vocabulary', () => {
  it('declares all five so M7 and M8 agree on the schema', () => {
    expect([...PENDING_MUTATION_STATUSES]).toEqual([
      'PENDING',
      'SYNCING',
      'CONFLICT',
      'BLOCKED',
      'SYNCED',
    ]);
  });
});
