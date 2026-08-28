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

    // An answered mutation is what puts a canonical snapshot on disk — `adopt` only paints it.
    // The server echoes the client's own `orderId` — that is what makes a lost `CREATE_ORDER`
    // response recoverable — so the mock does too.
    postMutationMock.mockImplementationOnce((orderId) =>
      Promise.resolve({ status: 'APPLIED', serverVersion: 3, order: snapshot(orderId, 3) }),
    );
    await before.createOrder('pos-1', 'demo-restaurant', '12');
    const orderId = before.currentOrderId ?? '';

    // The next request left the terminal and produced no answer: this is the only state in the
    // whole system where losing a client-side fact loses money.
    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await before.addItem('pos-1', 'demo-restaurant', 'burger');
    const sentId = before.queue[0]?.mutationId;
    expect(sentId).toBeDefined();

    reload();

    const after = useOrderStore();
    after.useTerminal('pos-1');
    // Hydration ends with a canonical read and then a pass over the queue, so the re-send happens
    // inside `hydrate` rather than being asked for by a button.
    fetchOrderMock.mockImplementationOnce((id) => Promise.resolve(snapshot(id, 3)));
    postMutationMock.mockImplementationOnce((id) =>
      Promise.resolve({ status: 'ALREADY_APPLIED', serverVersion: 4, order: snapshot(id, 4) }),
    );
    await after.hydrate('pos-1');

    expect(after.currentOrderId).toBe(orderId);

    const [, request] = postMutationMock.mock.calls.at(-1) ?? [];
    // The same id and the same base version, so §9 answers `ALREADY_APPLIED` instead of adding a
    // second burger. A fresh id here is the one bug in this milestone that loses money.
    expect(request?.mutationId).toBe(sentId);
    expect(request?.baseVersion).toBe(3);
    expect(after.pendingCount).toBe(0);
    expect(after.version).toBe(4);
  });

  it('leaves the row PENDING when no answer came and deletes it when one did', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    const held = await db.pendingMutations.toArray();
    expect(held).toHaveLength(1);
    expect(held[0]?.status).toBe('PENDING');

    postMutationMock.mockResolvedValueOnce(applied(4));
    await orders.sync();

    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('caches the answer before dropping the identity that could recover it', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');

    // The two writes are not atomic and the tab can die between them. Deleting first leaves the
    // one state that loses money on a `CREATE_ORDER`: no row, no snapshot, and no pointer either,
    // because `createOrder` clears it before sending — so the reload shows an empty till and the
    // operator rings the order up again.
    const seenAtDelete: (string | undefined)[] = [];
    const realDelete = localStore.deletePending.bind(localStore);
    vi.spyOn(localStore, 'deletePending').mockImplementation(async (mutationId: string) => {
      const cached = await db.orders.toArray();
      seenAtDelete.push(cached[0] === undefined ? undefined : `v${cached[0].snapshot.version}`);
      await realDelete(mutationId);
    });

    postMutationMock.mockImplementationOnce((orderId) =>
      Promise.resolve({ status: 'APPLIED', serverVersion: 3, order: snapshot(orderId, 3) }),
    );
    await orders.createOrder('pos-1', 'demo-restaurant', '12');

    expect(seenAtDelete).toEqual(['v3']);
  });

  it('caches the answer for the terminal that sent it, not the one on screen', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    let release: (value: MutationResponse) => void = () => {};
    let requestSent: () => void = () => {};
    const sent = new Promise<void>((resolve) => {
      requestSent = resolve;
    });
    postMutationMock.mockImplementationOnce(() => {
      requestSent();
      return new Promise<MutationResponse>((resolve) => {
        release = resolve;
      });
    });
    const sending = orders.addItem('pos-1', 'demo-restaurant', 'burger');
    // The enqueue and the send are two steps: wait until the request is genuinely in the air.
    await sent;

    // The operator walks to another terminal — another restaurant — before the answer lands.
    orders.useTerminal('pos-3');
    release(applied(4));
    await sending;

    // The answer belongs to pos-1 and is cached for pos-1. Keying it by the screen would put
    // another tenant's order behind pos-3's pointer.
    expect((await localStore.readTerminalState('pos-1')).order?.version).toBe(4);
    expect((await localStore.readTerminalState('pos-3')).order).toBeUndefined();
  });

  it('puts a SYNCING row back to PENDING, because that label means "this tab, right now"', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    // The tab dies while the request is in the air: the row keeps the label and there is nobody
    // left attempting it. A pass that trusted the label would skip the mutation for ever.
    postMutationMock.mockImplementationOnce(() => new Promise<MutationResponse>(() => {}));
    void orders.addItem('pos-1', 'demo-restaurant', 'burger');
    await vi.waitFor(async () => {
      expect((await db.pendingMutations.toArray())[0]?.status).toBe('SYNCING');
    });

    reload();
    const after = useOrderStore();
    after.useTerminal('pos-1');
    fetchOrderMock.mockResolvedValueOnce(snapshot('order-a', 3));
    postMutationMock.mockResolvedValueOnce(applied(4));
    await after.hydrate('pos-1');

    // Re-sent with the same id, so §9 answers `ALREADY_APPLIED` if it did in fact apply.
    expect(postMutationMock.mock.calls.at(-1)?.[1]?.mutationId).toBe(
      postMutationMock.mock.calls[0]?.[1]?.mutationId,
    );
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('forgets the halted mutations for good when the operator discards them', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockResolvedValueOnce({
      status: 'CONFLICT',
      reason: 'ORDER_CANCELLED',
      clientBaseVersion: 3,
      serverVersion: 4,
      canonicalOrder: snapshot('order-a', 4),
    });
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');
    expect(orders.halted).toBe(true);

    await orders.discardHalted();

    reload();
    const after = useOrderStore();
    after.useTerminal('pos-1');
    fetchOrderMock.mockResolvedValueOnce(snapshot('order-a', 4));
    await after.hydrate('pos-1');

    // A discard that only cleared memory would ask the operator the same question again on the
    // next reload — and the labels it cleared are the durable half of §14.1's halt.
    expect(after.pendingCount).toBe(0);
    expect(after.halted).toBe(false);
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
    orders.adopt(snapshot('order-b', 1));
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
    orders.adopt(snapshot('order-a', 7));
    await hydrating;

    expect(orders.version).toBe(7);
  });

  it('does not drop a mutation queued while it was reading from disk', async () => {
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
    orders.adopt(snapshot('order-a', 3));

    // Everything the server is asked for during this test fails, so both rows stay queued and can
    // be counted.
    postMutationMock.mockRejectedValue(new Error('network down'));
    fetchOrderMock.mockRejectedValue(new Error('network down'));

    const hydrating = orders.hydrate('pos-1');
    await orders.sendToKitchen('pos-1', 'demo-restaurant');
    await hydrating;

    // The mirror is re-read rather than assigned from a list captured before the new intent was
    // written; installing the older list would have hidden the fresher mutation from the screen.
    expect(orders.queue.map((row) => row.type)).toEqual(['ADD_ITEM', 'SEND_TO_KITCHEN']);
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
    // pos-1's queue is on disk and pos-3's screen has no business mirroring it.
    expect(orders.queue).toEqual([]);
    expect(await localStore.readQueue('pos-1')).toHaveLength(1);
  });

  it('writes nothing once the screen has gone away entirely', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-a', 3));

    reload();
    const orders = useOrderStore();
    orders.useTerminal('pos-1');

    const hydrating = orders.hydrate('pos-1');

    // `onBeforeUnmount`, then the route is re-entered on the *same* terminal before the read
    // lands. The terminal id survives the teardown, so an owner check written against the id
    // alone passes here — the departed screen's hydration writes into its successor. Only a
    // generation distinguishes the two mounts.
    void orders.clear();
    orders.releaseTerminal();
    orders.useTerminal('pos-1');

    await hydrating;

    expect(orders.order).toBeUndefined();
  });

  it('ends with a canonical read, whatever the transport does', async () => {
    await localStore.saveOrder('pos-1', snapshot('order-a', 3));

    reload();
    const orders = useOrderStore();
    orders.useTerminal('pos-1');

    // With `realtime.websocket_push` off, or `GET /api/config` failing, `connection.start` never
    // opens a socket and its `onConnected` refresh never runs. The cache would then sit on screen
    // for as long as the tab stayed open.
    fetchOrderMock.mockResolvedValueOnce(snapshot('order-a', 9));
    await orders.hydrate('pos-1');

    // Read as the terminal that asked, so a terminal simulating an offline device does not
    // quietly refresh itself.
    expect(fetchOrderMock).toHaveBeenCalledWith('order-a', 'pos-1');
    expect(orders.version).toBe(9);
    expect((await localStore.readTerminalState('pos-1')).order?.version).toBe(9);
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
    orders.adopt(snapshot('order-a', 3));

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
