import type { MutationResponse, OrderSnapshot } from '@pos/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOrder, postConflictResolution, postMutation } from '../src/api/client';
import { localStore } from '../src/persistence/local-store';
import { useOrderStore } from '../src/stores/order';

vi.mock('../src/api/client', () => ({
  postMutation: vi.fn(),
  fetchOrder: vi.fn(),
  postConflictResolution: vi.fn(() => Promise.resolve({ resolved: 1 })),
}));

const postMutationMock = vi.mocked(postMutation);
const fetchOrderMock = vi.mocked(fetchOrder);

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

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

describe('reporting how a halt was resolved', () => {
  /**
   * `postConflictResolution` goes through `assertOnline`, which throws **synchronously** on a
   * terminal holding §18's offline switch. Offline is precisely when §19.3 discards a halted queue,
   * so a report that threw at the call site would come out of the resolution the operator chose —
   * an observability field breaking a till.
   */
  it('does not let a failed report break the resolution', async () => {
    vi.mocked(postConflictResolution).mockImplementation(() => {
      throw new Error('this terminal is offline');
    });

    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValue(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    await expect(orders.discardHalted()).resolves.toBeUndefined();
    expect(orders.pendingCount).toBe(0);
  });
});

describe('two taps inside one millisecond', () => {
  /**
   * The queue is read in `createdAt` order and `createdAt` is a millisecond. Until M20 two taps
   * inside one millisecond were therefore ordered by the index's tiebreak — the primary key, which
   * is a random UUID — so the mutation stamped at `baseVersion` 4 could be sent in front of the one
   * stamped at 3 and halt the aggregate on a race the operator never caused. M15's large touch
   * targets made that ordinary rather than exotic.
   *
   * Both halves are forced here: the clock does not move, and the ids are chosen so that a
   * tiebreak on the key would put the *second* tap first.
   */
  it('keeps the operator order when the clock does not move and the ids sort backwards', async () => {
    const frozen = Date.parse('2026-08-28T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(frozen);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('ffffffff-ffff-4fff-8fff-ffffffffffff')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000000');

    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValue(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');
    await orders.sendToKitchen('pos-1', 'demo-restaurant');

    expect(orders.queue.map((row) => row.type)).toEqual(['ADD_ITEM', 'SEND_TO_KITCHEN']);
    expect(orders.queue.map((row) => row.baseVersion)).toEqual([3, 4]);

    // The stamps are distinct and increasing even though the wall clock never advanced: the queue
    // clock is one millisecond past the newest row on disk, not `Date.now()`.
    const [first, second] = orders.queue;
    expect(first?.createdAt).toBe('2026-08-28T10:00:00.000Z');
    expect(second?.createdAt).toBe('2026-08-28T10:00:00.001Z');
  });
});

describe('a device that cannot store anything', () => {
  /**
   * M7's rule is that a storage failure never breaks a command: with no queue row to carry it, the
   * mutation is sent straight through the engine. Until M20 that send sat *outside* the serialized
   * local phase, and the projection over a device with no queue is the cached order alone — so two
   * rapid taps both stamped the same `baseVersion`, one applied and the rest conflicted, on the one
   * device that has no queue to halt.
   */
  it('sends rapid taps one at a time, each stamped at the version the last one produced', async () => {
    vi.spyOn(localStore, 'savePending').mockResolvedValue(false);

    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock
      .mockResolvedValueOnce({
        status: 'APPLIED',
        order: snapshot('order-a', 4),
        serverVersion: 4,
      } satisfies MutationResponse)
      .mockResolvedValueOnce({
        status: 'APPLIED',
        order: snapshot('order-a', 5),
        serverVersion: 5,
      } satisfies MutationResponse);

    // Both taps are issued before either answer arrives — the operator did not wait, and neither
    // does the screen.
    const first = orders.addItem('pos-1', 'demo-restaurant', 'burger');
    const second = orders.addItem('pos-1', 'demo-restaurant', 'fries');
    await Promise.all([first, second]);

    const sent = postMutationMock.mock.calls.map(([, request]) => request?.baseVersion);
    expect(sent).toEqual([3, 4]);
    expect(orders.version).toBe(5);
    expect(orders.halted).toBe(false);
  });
});

describe('the queue is a queue, not a slot', () => {
  it('accepts more commands behind one that got no answer, in creation order', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    // The request left the terminal and produced no answer: the outcome is unknown.
    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    // M7 refused this — there was one slot and a second command would have overwritten the only
    // id that could settle the first. §14 says the opposite: the UI never waits, the intent is
    // queued behind the one in front of it.
    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.sendToKitchen('pos-1', 'demo-restaurant');

    expect(orders.queue.map((row) => row.type)).toEqual(['ADD_ITEM', 'SEND_TO_KITCHEN']);
    expect(orders.pendingCount).toBe(2);
    // Stamped at the *projected* version: the second mutation assumes the first one applied,
    // which is exactly what the server will produce when the queue drains in order.
    expect(orders.queue.map((row) => row.baseVersion)).toEqual([3, 4]);
    expect(orders.halted).toBe(false);
  });

  it('shows the operator their own actions before the server has answered', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValue(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger', 2);

    // §14: the UI updates optimistically and never waits. The canonical snapshot is untouched.
    expect(orders.projected?.items).toEqual([
      expect.objectContaining({ productId: 'burger', quantity: 2 }),
    ]);
    expect(orders.version).toBe(4);
    expect(orders.order?.items).toEqual([]);
    expect(orders.canonicalVersion).toBe(3);
  });

  it('re-sends with the stored mutationId and deletes the row on the answer', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');
    const queued = orders.queue[0];

    postMutationMock.mockResolvedValueOnce({
      status: 'ALREADY_APPLIED',
      order: snapshot('order-a', 4),
      serverVersion: 4,
    });
    await orders.sync();

    const [, resent] = postMutationMock.mock.calls[1] ?? [];
    // A fresh id would turn the re-send into a second mutation at a stale version: a duplicate
    // line, or a conflict reported over an operation that in fact succeeded.
    expect(resent?.mutationId).toBe(queued?.mutationId);
    expect(resent?.baseVersion).toBe(3);
    expect(orders.pendingCount).toBe(0);
    expect(orders.version).toBe(4);
  });

  it('keeps the queue when the operator starts a new order', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    // "New order" is not an answer to "did that apply?" — and the halt is per aggregate, so the
    // mutation for the order the screen has left keeps syncing on its own.
    await orders.clear();
    expect(orders.pendingCount).toBe(1);
    expect(orders.currentQueue).toEqual([]);
    expect(orders.pendingForOtherOrders).toBe(1);
  });
});

describe('§14.1 on the screen', () => {
  const cancelledAt = (version: number): MutationResponse => ({
    status: 'CONFLICT',
    reason: 'ORDER_CANCELLED',
    clientBaseVersion: 3,
    serverVersion: version,
    canonicalOrder: { ...snapshot('order-a', version), status: 'CANCELLED' },
  });

  it('shows the canonical state beside the local intent and refuses new commands', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');
    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.sendToKitchen('pos-1', 'demo-restaurant');

    postMutationMock.mockResolvedValueOnce(cancelledAt(6));
    await orders.sync();

    expect(orders.halted).toBe(true);
    expect(orders.conflictedMutation?.type).toBe('ADD_ITEM');
    expect(orders.blockedMutations.map((row) => row.type)).toEqual(['SEND_TO_KITCHEN']);
    // The server's truth is on screen next to the intent that was refused.
    expect(orders.order?.status).toBe('CANCELLED');
    expect(orders.currentConflict?.reason).toBe('ORDER_CANCELLED');

    // Nothing resolves itself, and nothing new joins a halted queue.
    const before = postMutationMock.mock.calls.length;
    await orders.pay('pos-1', 'demo-restaurant', 'CARD');
    expect(postMutationMock).toHaveBeenCalledTimes(before);
    expect(orders.lastError).toMatch(/halted/i);
  });

  it('discard empties the queue and leaves the canonical order on screen', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockResolvedValueOnce(cancelledAt(6));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    await orders.discardHalted();

    expect(orders.pendingCount).toBe(0);
    expect(orders.halted).toBe(false);
    // What the operator is accepting: the server's version of the order.
    expect(orders.projected?.status).toBe('CANCELLED');
    expect(orders.projected?.version).toBe(6);
  });

  it('does not move the durable pointer when a background order is answered', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');

    // The operator is on order B, which is fully synced.
    postMutationMock.mockImplementationOnce((orderId) =>
      Promise.resolve({ status: 'APPLIED', order: snapshot(orderId, 1), serverVersion: 1 }),
    );
    await orders.createOrder('pos-1', 'demo-restaurant', '14');
    const onScreen = orders.currentOrderId;

    // They step back to an older order A, queue a mutation there that gets no answer, and return
    // to B. A's queue keeps draining in the background — that is what per-aggregate buys.
    fetchOrderMock.mockResolvedValueOnce(snapshot('order-a', 3));
    await orders.focusOrder('order-a');
    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    fetchOrderMock.mockResolvedValueOnce(snapshot(onScreen ?? '', 1));
    await orders.focusOrder(onScreen ?? '');

    postMutationMock.mockImplementationOnce((orderId) =>
      Promise.resolve({ status: 'APPLIED', order: snapshot(orderId, 4), serverVersion: 4 }),
    );
    await orders.sync();

    // A's answer is a fact about A and nothing else. Moving the pointer with it would send the
    // next reload to the order the operator finished, and strand the one they are ringing up.
    const restored = await localStore.readTerminalState('pos-1');
    expect(restored.currentOrderId).toBe(onScreen);
    expect(orders.currentOrderId).toBe(onScreen);
    // A is still cached, just not pointed at.
    expect((await localStore.readOrder('order-a'))?.version).toBe(4);
  });

  it('keeps a halt reachable after the screen has moved to another order', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    // "New order" while the first order's mutation is still unsent. The halt lands on an order
    // this screen has already left — §21.8's shape, seen from the POS rather than the engine.
    await orders.clear();
    // The pass drains in creation order, so order-a's mutation goes first and is refused; the
    // creation behind it belongs to another aggregate and is unaffected by that halt.
    postMutationMock.mockResolvedValueOnce(cancelledAt(6));
    postMutationMock.mockImplementationOnce((orderId) =>
      Promise.resolve({ status: 'APPLIED', order: snapshot(orderId, 1), serverVersion: 1 }),
    );
    await orders.createOrder('pos-1', 'demo-restaurant', '14');
    const second = orders.currentOrderId;

    // The new order is unaffected; the old one is halted and says so.
    expect(orders.currentOrderId).toBe(second);
    expect(orders.halted).toBe(false);
    expect(orders.haltedElsewhere).toEqual(['order-a']);

    // And it can be returned to, which is the only thing that makes it resolvable.
    fetchOrderMock.mockResolvedValueOnce({ ...snapshot('order-a', 6), status: 'CANCELLED' });
    await orders.focusOrder('order-a');
    expect(orders.halted).toBe(true);
    expect(orders.haltedElsewhere).toEqual([]);
  });
});

describe('a refetch that outlives its question', () => {
  it('does not reinstall an order the screen has already left', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    let release: (value: OrderSnapshot | undefined) => void = () => undefined;
    fetchOrderMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = orders.refetch();

    // The operator moved on while the read was outstanding.
    await orders.clear();
    release(snapshot('order-a', 5));
    await inFlight;

    expect(orders.order).toBeUndefined();
  });

  it('does not replace a newer order with a slow read of the previous one', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    let release: (value: OrderSnapshot | undefined) => void = () => undefined;
    fetchOrderMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = orders.refetch();

    orders.adopt(snapshot('order-b', 1));
    release(snapshot('order-a', 9));
    await inFlight;

    // `acceptsSnapshot` alone would have taken it: a different id is exactly what a freshly
    // created order looks like. Only the caller knows this answers a stale question.
    expect(orders.order?.id).toBe('order-b');
  });
});

describe('a failed canonical read', () => {
  it('is not reported on a screen that has moved on', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    let reject: (error: Error) => void = () => undefined;
    fetchOrderMock.mockReturnValueOnce(
      new Promise((_resolve, r) => {
        reject = r;
      }),
    );

    const inFlight = orders.refetch();

    orders.adopt(snapshot('order-b', 1));
    reject(new Error('offline'));
    await inFlight;

    // An error about the order the operator already left belongs to nobody.
    expect(orders.readError).toBeUndefined();
  });

  it('is cleared by the next successful read of the same order', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    fetchOrderMock.mockRejectedValueOnce(new Error('offline'));
    await orders.refetch();
    expect(orders.readError).toBe('offline');

    fetchOrderMock.mockResolvedValueOnce(snapshot('order-a', 4));
    await orders.refetch();

    expect(orders.readError).toBeUndefined();
    expect(orders.version).toBe(4);
  });

  it('does not survive as a mutation error, nor swallow one', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    fetchOrderMock.mockRejectedValueOnce(new Error('offline'));
    await orders.refetch();

    // The two failures are separate facts with separate lifetimes.
    expect(orders.readError).toBe('offline');
    expect(orders.lastError).toBeUndefined();
  });
});

describe('a queued mutation belongs to the terminal that formed it', () => {
  it('is neither shown nor sent from another terminal', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');
    expect(orders.pendingCount).toBe(1);

    // The operator walks to POS-3, which belongs to the *other* restaurant.
    await orders.clear();
    orders.useTerminal('pos-3');
    await orders.sync();

    // POS-3's engine reads by terminal, so POS-1's row is not its to send.
    expect(postMutationMock).toHaveBeenCalledTimes(1);
    expect(orders.pendingCount).toBe(0);

    // POS-3 is free to work, and its own mutation does not disturb POS-1's unresolved one. The
    // server echoes the client's own `orderId`, which is what makes a lost `CREATE_ORDER` response
    // recoverable — so the mock does too.
    postMutationMock.mockImplementationOnce((orderId) =>
      Promise.resolve({ status: 'APPLIED', order: snapshot(orderId, 1), serverVersion: 1 }),
    );
    await orders.createOrder('pos-3', 'second-restaurant', '9');
    expect(orders.order?.id).toBe(orders.currentOrderId);
    expect(orders.version).toBe(1);

    // Back at POS-1 the unresolved mutation is still on disk, with the terminal that formed it.
    expect(await localStore.readQueue('pos-1')).toHaveLength(1);
  });

  it('never paints another terminal answer onto the screen that replaced it', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    let release: (value: MutationResponse) => void = () => undefined;
    let requestSent: () => void = () => undefined;
    const sent = new Promise<void>((resolve) => {
      requestSent = resolve;
    });
    postMutationMock.mockImplementationOnce(() => {
      requestSent();
      return new Promise((resolve) => {
        release = resolve;
      });
    });

    const inFlight = orders.addItem('pos-1', 'demo-restaurant', 'burger');
    // The enqueue and the send are two steps now, so the test waits for the request to be
    // genuinely in the air before moving the screen — otherwise it would be testing a mutation
    // that was never sent.
    await sent;

    // The route changed while the request was outstanding.
    await orders.clear();
    orders.useTerminal('pos-3');

    release({ status: 'APPLIED', order: snapshot('order-a', 4), serverVersion: 4 });
    await inFlight;

    // POS-3 would otherwise be showing an order from the first restaurant, and every command it
    // sent afterwards would come back CROSS_TENANT_MUTATION.
    expect(orders.order).toBeUndefined();
    // The answer still resolved the mutation: nothing is left on disk for POS-1.
    expect(await localStore.readQueue('pos-1')).toEqual([]);
  });
});
