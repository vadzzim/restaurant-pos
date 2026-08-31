import type { MutationResponse, OrderItemSnapshot, OrderSnapshot } from '@pos/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOrder, postMutation } from '../src/api/client';
import { useOrderStore } from '../src/stores/order';

vi.mock('../src/api/client', () => ({
  postMutation: vi.fn(),
  fetchOrder: vi.fn(),
}));

const postMutationMock = vi.mocked(postMutation);
const fetchOrderMock = vi.mocked(fetchOrder);

function snapshot(version: number, items: OrderItemSnapshot[] = []): OrderSnapshot {
  return {
    id: 'order-a',
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status: 'OPEN',
    version,
    totalCents: items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0),
    items,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

/**
 * Let the local phase of every issued command drain.
 *
 * The taps themselves are never awaited — their `postMutation` never answers, which is the point.
 * But `stage` is only a couple of IndexedDB round trips deep, and it runs whether or not the
 * network ever does, so ticking the event loop until the queue stops growing settles it.
 */
async function settleLocal(depth: number): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    // `depth === 0` means "nothing should have been queued", which no count can confirm early —
    // it has to spend the whole budget, or it would pass before the chain had a chance to write.
    if (depth > 0 && useOrderStore().pendingCount >= depth) {
      return;
    }
  }
}

/**
 * §16 asks for a till that is usable at rush speed, and §14 for a UI that never waits for the
 * server. Together they mean the operator's taps arrive faster than the answers do — which is a
 * concurrency problem, not a styling one, because `baseVersion` is stamped from the projection.
 *
 * Until M15 the POS screen hid it: one `busy` flag disabled the whole till until each round trip
 * finished, so commands could not overlap. These tests drive the store the way the screen now
 * does — without awaiting — and are the reason the ordering lives in the store.
 */
describe('taps issued faster than the server answers', () => {
  it('stamps each command at the version the one before it produces', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot(3));

    // A round trip that never returns: every tap below overlaps every other one.
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    const taps = [
      orders.addItem('pos-1', 'demo-restaurant', 'burger'),
      orders.addItem('pos-1', 'demo-restaurant', 'pizza'),
      orders.addItem('pos-1', 'demo-restaurant', 'cola'),
      orders.changeQuantity('pos-1', 'demo-restaurant', 'burger', 4),
    ];

    // Nothing is awaited before the next tap is issued — this is a thumb on a touchscreen, not a
    // test being polite. The commands must still queue in order and at distinct versions.
    expect(taps).toHaveLength(4);
    await settleLocal(4);

    expect(orders.queue.map((row) => row.type)).toEqual([
      'ADD_ITEM',
      'ADD_ITEM',
      'ADD_ITEM',
      'CHANGE_QUANTITY',
    ]);
    // The defect this pins: without serialization every tap reads the same projected version,
    // stamps `baseVersion: 3`, and the server halts the queue on a `VERSION_CONFLICT` the
    // operator never caused.
    expect(orders.queue.map((row) => row.baseVersion)).toEqual([3, 4, 5, 6]);
    expect(orders.halted).toBe(false);
  });

  it('shows every tap on the ticket while all of them are still unanswered', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot(3));
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    const taps = [
      orders.addItem('pos-1', 'demo-restaurant', 'burger'),
      orders.addItem('pos-1', 'demo-restaurant', 'burger'),
      orders.addItem('pos-1', 'demo-restaurant', 'burger'),
    ];
    expect(taps).toHaveLength(3);
    await settleLocal(3);

    // Three taps on one tile is a quantity of three (§16, "quantity reachable in one tap"), and it
    // is on screen with no answer from the server for any of them.
    expect(orders.projected?.items).toEqual([
      expect.objectContaining({ productId: 'burger', quantity: 3 }),
    ]);
    expect(orders.pendingCount).toBe(3);
    expect(orders.canonicalVersion).toBe(3);
    expect(fetchOrderMock).not.toHaveBeenCalled();
  });

  it('keeps ordering the rest after one tap is refused', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot(3));
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    const taps = [
      orders.addItem('pos-1', 'demo-restaurant', 'burger'),
      // Not this terminal's mutation: `stage` refuses it, and the chain must survive the refusal
      // rather than wedging every tap behind it.
      orders.addItem('pos-2', 'demo-restaurant', 'pizza'),
      orders.addItem('pos-1', 'demo-restaurant', 'cola'),
    ];
    expect(taps).toHaveLength(3);
    await settleLocal(2);

    expect(orders.queue.map((row) => row.baseVersion)).toEqual([3, 4]);
    expect(orders.lastError).toMatch(/pos-2/);
  });
});

/**
 * The three defects the Codex review of M15 found in the fire-and-forget path. Each is a race that
 * only exists *because* taps no longer wait for the server, so each is pinned here rather than in
 * a screen test — the screen has no way to reproduce them deterministically.
 */
describe('what the fire-and-forget path opened up', () => {
  it('steps the quantity from the projection, not from the rendered row', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot(3));
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    // Three taps on the tile. The row on screen may still be showing 1 while these stage.
    orders.addItem('pos-1', 'demo-restaurant', 'burger');
    orders.addItem('pos-1', 'demo-restaurant', 'burger');
    orders.addItem('pos-1', 'demo-restaurant', 'burger');
    // ...and the operator presses `+` before any of them is answered.
    orders.stepQuantity('pos-1', 'demo-restaurant', 'burger', 1);
    await settleLocal(4);

    const step = orders.queue.find((row) => row.type === 'CHANGE_QUANTITY');
    // 4, not 2: the absolute value is computed inside the serialized link, where the three adds
    // are already visible. A template computing `item.quantity + 1` off a stale render sent 2 and
    // silently overwrote two of them.
    expect(step?.payload).toEqual({ productId: 'burger', quantity: 4 });
    expect(orders.projected?.items).toEqual([
      expect.objectContaining({ productId: 'burger', quantity: 4 }),
    ]);
  });

  it('does not collapse two quick steps onto the same absolute quantity', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(
      snapshot(3, [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }]),
    );
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    orders.stepQuantity('pos-1', 'demo-restaurant', 'burger', 1);
    orders.stepQuantity('pos-1', 'demo-restaurant', 'burger', 1);
    await settleLocal(2);

    // 1 → 2 → 3. Two `+` off the same stale render both sent 2, so the second was a no-op.
    expect(orders.queue.map((row) => row.payload)).toEqual([
      { productId: 'burger', quantity: 2 },
      { productId: 'burger', quantity: 3 },
    ]);
    expect(orders.projected?.items).toEqual([
      expect.objectContaining({ productId: 'burger', quantity: 3 }),
    ]);
  });

  it('turns a step below one into a removal, at the version the steps before it produce', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(
      snapshot(3, [{ productId: 'burger', name: 'Burger', quantity: 2, unitPriceCents: 1200 }]),
    );
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    orders.stepQuantity('pos-1', 'demo-restaurant', 'burger', -1);
    orders.stepQuantity('pos-1', 'demo-restaurant', 'burger', -1);
    await settleLocal(2);

    expect(orders.queue.map((row) => row.type)).toEqual(['CHANGE_QUANTITY', 'REMOVE_ITEM']);
    expect(orders.queue.map((row) => row.baseVersion)).toEqual([3, 4]);
    expect(orders.projected?.items).toEqual([]);
  });

  it('plans nothing for a line the order no longer has', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot(3));
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    // §8 answers CHANGE_QUANTITY for a missing line with ITEM_NOT_IN_ORDER, which halts the queue.
    // A stepper firing off a stale render must not be what causes that.
    orders.stepQuantity('pos-1', 'demo-restaurant', 'burger', 1);
    await settleLocal(0);

    expect(orders.queue).toEqual([]);
    expect(orders.halted).toBe(false);
  });

  it('keeps a tap on the order it was meant for when the next cover is opened over it', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot(3));
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    // The last tap on this cover, and the next cover opened before it has been answered.
    orders.addItem('pos-1', 'demo-restaurant', 'burger');
    orders.createOrder('pos-1', 'demo-restaurant', '7');
    await settleLocal(2);

    const [item, created] = orders.queue;
    expect(item?.type).toBe('ADD_ITEM');
    expect(created?.type).toBe('CREATE_ORDER');
    // The pointer moves inside the chain, so the add belongs to the order it was rung up on and
    // the new order's CREATE_ORDER is behind it — not in front of an ADD_ITEM that would then
    // reach the server first and halt on a missing aggregate.
    expect(item?.orderId).toBe('order-a');
    expect(created?.orderId).not.toBe('order-a');
    expect(orders.currentOrderId).toBe(created?.orderId);
    expect(orders.halted).toBe(false);
  });

  it('refuses a tap staged after the screen has left the order', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot(3));
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    orders.clear();
    orders.addItem('pos-1', 'demo-restaurant', 'burger');
    await settleLocal(0);

    expect(orders.queue).toEqual([]);
    expect(orders.currentOrderId).toBeUndefined();
  });
});

/**
 * **The P2 the Codex review of M23 found**, and the one place a rush tap and a pointer move race.
 *
 * `command` reads `currentOrderId` when the thumb lands and re-checks it inside its serialized link,
 * so anything that moves the pointer has to move it *in that chain* or the taps already accepted are
 * refused. `createOrder` and `clear` always did; `focusOrder` did not, and M23 gave it a second
 * caller — the "Take it" field — pressed at exactly the moment taps are still in flight.
 *
 * The defect is M16's: "Go to it" had it too, and both callers go through this function.
 */
describe('taps in flight when the screen is moved to another order', () => {
  it('stamps every accepted tap for the order it was meant for', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot(3));
    postMutationMock.mockReturnValue(new Promise<MutationResponse>(() => undefined));

    // Three thumbs on the tiles, none of them awaited...
    const taps = [
      orders.addItem('pos-1', 'demo-restaurant', 'burger'),
      orders.addItem('pos-1', 'demo-restaurant', 'pizza'),
      orders.addItem('pos-1', 'demo-restaurant', 'cola'),
    ];
    expect(taps).toHaveLength(3);

    // ...and then, in the same breath, the operator takes another till's order. Not awaited either:
    // `focusOrder` has to get in line behind the taps, not overtake them.
    fetchOrderMock.mockResolvedValue({ ...snapshot(9), id: 'order-from-pos-2' });
    const focused = orders.focusOrder('order-from-pos-2');

    await settleLocal(3);
    await focused;

    // All three reached the queue, at distinct versions, stamped for `order-a` — not one of them
    // refused because the pointer had already moved to the order that replaced it.
    expect(orders.queue.map((row) => row.orderId)).toEqual(['order-a', 'order-a', 'order-a']);
    expect(orders.queue.map((row) => row.baseVersion)).toEqual([3, 4, 5]);
    expect(orders.lastError).toBeUndefined();

    // And the screen did move: the pointer is on the new order and the queue for it is empty.
    expect(orders.currentOrderId).toBe('order-from-pos-2');
    expect(orders.currentQueue).toHaveLength(0);
  });
});
