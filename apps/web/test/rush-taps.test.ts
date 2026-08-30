import type { MutationResponse, OrderSnapshot } from '@pos/contracts';
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

function snapshot(version: number): OrderSnapshot {
  return {
    id: 'order-a',
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
    if (useOrderStore().pendingCount >= depth) {
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
