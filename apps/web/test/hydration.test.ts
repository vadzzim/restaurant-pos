import type { MutationResponse, OrderSnapshot } from '@pos/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOrder, postKitchenCommand, postMutation } from '../src/api/client';
import { db } from '../src/persistence/db';
import { localStore, persistenceError } from '../src/persistence/local-store';
import { useKitchenStore } from '../src/stores/kitchen';
import { useOrderStore } from '../src/stores/order';

vi.mock('../src/api/client', () => ({
  postMutation: vi.fn(),
  fetchOrder: vi.fn(),
  fetchTickets: vi.fn(),
  postKitchenCommand: vi.fn(),
}));

const postMutationMock = vi.mocked(postMutation);
const fetchOrderMock = vi.mocked(fetchOrder);
const postKitchenCommandMock = vi.mocked(postKitchenCommand);

function snapshot(id: string, version: number): OrderSnapshot {
  return {
    id,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status: 'OPEN',
    version,
    totalCents: 0,
    items: [],
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

const applied = (version: number): MutationResponse => ({
  status: 'ALREADY_APPLIED',
  serverVersion: version,
  order: snapshot('order-a', version),
});

/** A reload: the tab is gone, the database is not. */
function reload(): void {
  setActivePinia(createPinia());
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a reload keeps the order and the identity of what was in flight', () => {
  it('restores both, and the retry carries the mutationId that was sent', async () => {
    const before = useOrderStore();
    before.useTerminal('pos-1');
    await before.adopt(snapshot('order-a', 3));

    // The request left the terminal and produced no answer: this is the only state in the whole
    // system where losing a client-side fact loses money.
    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await before.addItem('pos-1', 'demo-restaurant', 'burger');
    const sentId = before.pending?.mutationId;
    expect(sentId).toBeDefined();

    reload();

    const after = useOrderStore();
    after.useTerminal('pos-1');
    await after.hydrate('pos-1');

    expect(after.order?.id).toBe('order-a');
    expect(after.order?.version).toBe(3);
    expect(after.pending?.mutationId).toBe(sentId);
    expect(after.blocked).toBe(true);

    postMutationMock.mockResolvedValueOnce(applied(4));
    await after.retryPending();

    const [, request] = postMutationMock.mock.calls[1] ?? [];
    // The same id and the same base version, so §9 answers `ALREADY_APPLIED` instead of adding a
    // second burger. A fresh id here is the one bug in this milestone that loses money.
    expect(request?.mutationId).toBe(sentId);
    expect(request?.baseVersion).toBe(3);
    expect(after.pending).toBeUndefined();
    expect(after.version).toBe(4);
  });

  it('leaves the row PENDING when no answer came and deletes it when one did', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    await orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    const held = await db.pendingMutations.toArray();
    expect(held).toHaveLength(1);
    expect(held[0]?.status).toBe('PENDING');

    postMutationMock.mockResolvedValueOnce(applied(4));
    await orders.retryPending();

    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('writes no status M8 has not been built for yet', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    await orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    const statuses = (await db.pendingMutations.toArray()).map((row) => row.status);
    // `CONFLICT`, `BLOCKED` and `SYNCED` are §14.1's, and §14.1 is M8's.
    expect(statuses.every((status) => status === 'PENDING' || status === 'SYNCING')).toBe(true);
  });

  it('forgets the mutation for good when the operator discards it', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    await orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');
    await orders.discardPending();

    reload();
    const after = useOrderStore();
    after.useTerminal('pos-1');
    await after.hydrate('pos-1');

    // A discard that only cleared memory would ask the operator the same unanswerable question
    // again on the next reload.
    expect(after.pending).toBeUndefined();
    expect(await db.pendingMutations.count()).toBe(0);
  });
});

describe('hydration is a checked writer, not a privileged one', () => {
  it('does not install the cached order over one created while it was reading', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-a', 3));

    reload();
    const orders = useOrderStore();
    orders.useTerminal('pos-1');

    // The read is in flight; the operator creates a new order before it lands.
    const hydrating = orders.hydrate('pos-1');
    await orders.adopt(snapshot('order-b', 1));
    await hydrating;

    // `adopt` accepts a different order unconditionally — that is how a CREATE_ORDER response
    // installs a new aggregate — so the emptiness check is what stops the cache winning here.
    expect(orders.order?.id).toBe('order-b');
    expect(orders.order?.version).toBe(1);
  });

  it('does not install the cached order over a newer snapshot of the same order', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-a', 3));

    reload();
    const orders = useOrderStore();
    orders.useTerminal('pos-1');

    const hydrating = orders.hydrate('pos-1');
    await orders.adopt(snapshot('order-a', 7));
    await hydrating;

    expect(orders.version).toBe(7);
  });

  it('does not overwrite a pending slot that is already filled', async () => {
    await localStore.savePending({
      mutationId: 'stored',
      restaurantId: 'demo-restaurant',
      terminalId: 'pos-1',
      orderId: 'order-a',
      baseVersion: 3,
      type: 'ADD_ITEM',
      payload: { productId: 'burger', quantity: 1 },
      status: 'PENDING',
    });

    reload();
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    await orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.sendToKitchen('pos-1', 'demo-restaurant');
    const fresher = orders.pending?.mutationId;

    await orders.hydrate('pos-1');

    // The in-memory intent is the more recent one; the stored row is M8's queue to reconcile,
    // not a startup path's to overrule.
    expect(orders.pending?.mutationId).toBe(fresher);
    expect(orders.pending?.type).toBe('SEND_TO_KITCHEN');
  });

  it('writes nothing once the screen has moved to another terminal', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-a', 3));
    await localStore.savePending({
      mutationId: 'pos-1-intent',
      restaurantId: 'demo-restaurant',
      terminalId: 'pos-1',
      orderId: 'order-a',
      baseVersion: 3,
      type: 'ADD_ITEM',
      payload: { productId: 'burger', quantity: 1 },
      status: 'PENDING',
    });

    reload();
    const orders = useOrderStore();
    orders.useTerminal('pos-1');

    const hydrating = orders.hydrate('pos-1');
    // pos-3 is another restaurant. Adopting pos-1's order here would put another tenant's order
    // on screen, and every command sent from it would be refused as cross-tenant.
    orders.useTerminal('pos-3');
    await hydrating;

    expect(orders.order).toBeUndefined();
    expect(orders.pending).toBeUndefined();

    orders.useTerminal('pos-1');
    expect(orders.pending).toBeUndefined();
  });

  it('collects a cached order nothing refers to any more', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-old', 1));
    await localStore.clearCurrentOrder('pos-1');
    await localStore.saveOrder('pos-1', snapshot('order-a', 3));

    reload();
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    await orders.hydrate('pos-1');

    expect(orders.order?.id).toBe('order-a');
    expect(await db.orders.get('order-old')).toBeUndefined();
  });
});

describe('the kitchen rail across a reload', () => {
  it('restores its own restaurant’s commands and no other', async () => {
    await localStore.savePending({
      mutationId: 'ours',
      restaurantId: 'demo-restaurant',
      terminalId: 'kitchen-display',
      orderId: 'order-a',
      baseVersion: 6,
      type: 'START_PREPARING',
      payload: {},
      status: 'PENDING',
    });
    await localStore.savePending({
      mutationId: 'theirs',
      restaurantId: 'second-restaurant',
      terminalId: 'kitchen-display',
      orderId: 'order-z',
      baseVersion: 2,
      type: 'MARK_READY',
      payload: {},
      status: 'PENDING',
    });

    const kitchen = useKitchenStore();
    await kitchen.hydrateCommands('demo-restaurant');

    expect(kitchen.pendingByOrder.get('order-a')?.mutationId).toBe('ours');
    expect(kitchen.pendingByOrder.get('order-a')?.command).toBe('preparing');
    expect(kitchen.pendingByOrder.get('order-a')?.baseVersion).toBe(6);
    // Every kitchen row carries the same terminal id; the restaurant filter is the tenant guard.
    expect(kitchen.pendingByOrder.has('order-z')).toBe(false);
  });

  it('retries a restored command with the identity that was stored', async () => {
    await localStore.savePending({
      mutationId: 'stored-command',
      restaurantId: 'demo-restaurant',
      terminalId: 'kitchen-display',
      orderId: 'order-a',
      baseVersion: 6,
      type: 'MARK_READY',
      payload: {},
      status: 'PENDING',
    });

    const after = useKitchenStore();
    await after.hydrateCommands('demo-restaurant');

    postKitchenCommandMock.mockResolvedValueOnce({
      status: 'ALREADY_APPLIED',
      serverVersion: 7,
      order: snapshot('order-a', 7),
    });
    await after.retry('order-a');

    const call = postKitchenCommandMock.mock.calls.at(-1);
    // `MARK_READY` came back out of storage as the rail's own vocabulary, with nothing regenerated.
    expect(call?.[1]).toBe('ready');
    expect(call?.[2].mutationId).toBe('stored-command');
    expect(call?.[2].baseVersion).toBe(6);
    expect(call?.[2].terminalId).toBe('kitchen-display');
  });

  it('does not overwrite a command it already holds', async () => {
    const kitchen = useKitchenStore();
    await localStore.savePending({
      mutationId: 'stored',
      restaurantId: 'demo-restaurant',
      terminalId: 'kitchen-display',
      orderId: 'order-a',
      baseVersion: 6,
      type: 'START_PREPARING',
      payload: {},
      status: 'PENDING',
    });

    kitchen.pendingByOrder.set('order-a', {
      orderId: 'order-a',
      restaurantId: 'demo-restaurant',
      command: 'ready',
      mutationId: 'in-memory',
      baseVersion: 7,
    });

    await kitchen.hydrateCommands('demo-restaurant');

    expect(kitchen.pendingByOrder.get('order-a')?.mutationId).toBe('in-memory');
  });
});

describe('a device that cannot store anything still takes orders', () => {
  it('sends the mutation and says the device is not durable', async () => {
    vi.spyOn(db.pendingMutations, 'put').mockRejectedValue(new Error('QuotaExceededError'));

    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    await orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockResolvedValueOnce(applied(4));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    // The command reached the server; only the durability promise was broken, and it says so.
    expect(postMutationMock).toHaveBeenCalledTimes(1);
    expect(orders.version).toBe(4);
    expect(persistenceError.value).toMatch(/QuotaExceededError/);

    vi.restoreAllMocks();
  });

  it('does not turn a failed read into a failed screen', async () => {
    vi.spyOn(db.syncMetadata, 'get').mockRejectedValue(new Error('database is closed'));

    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    await expect(orders.hydrate('pos-1')).resolves.toBeUndefined();

    expect(orders.order).toBeUndefined();
    expect(fetchOrderMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
