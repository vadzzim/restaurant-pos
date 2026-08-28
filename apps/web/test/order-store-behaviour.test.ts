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

describe('an unresolved mutation halts the terminal', () => {
  it('refuses a different command rather than overwriting the only id that can settle the first', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    // The request left the terminal and produced no answer: the outcome is unknown.
    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    const held = orders.pending;
    expect(held?.type).toBe('ADD_ITEM');
    expect(orders.blocked).toBe(true);

    // A different command would replace `mutationId`, and the first mutation's fate would become
    // permanently unknowable — no retry could ever resolve it under §9.
    await orders.sendToKitchen('pos-1', 'demo-restaurant');

    expect(postMutationMock).toHaveBeenCalledTimes(1);
    expect(orders.pending).toBe(held);
    expect(orders.lastError).toMatch(/no answer yet/i);
  });

  it('retries with the identical identity and clears on the answer', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');
    const held = orders.pending;

    postMutationMock.mockResolvedValueOnce({
      status: 'ALREADY_APPLIED',
      order: snapshot('order-a', 4),
      serverVersion: 4,
    });
    await orders.retryPending();

    const [, retried] = postMutationMock.mock.calls[1] ?? [];
    expect(retried?.mutationId).toBe(held?.mutationId);
    expect(retried?.baseVersion).toBe(3);
    expect(orders.pending).toBeUndefined();
    expect(orders.blocked).toBe(false);
    expect(orders.version).toBe(4);
  });

  it('keeps the pending mutation when the operator starts a new order', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');

    // "New order" is not an answer to "did that apply?".
    orders.clear();
    expect(orders.pending).toBeDefined();

    orders.discardPending();
    expect(orders.pending).toBeUndefined();
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
    orders.clear();
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

describe('a pending mutation belongs to the terminal that sent it', () => {
  it('is neither shown nor retried from another terminal', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    postMutationMock.mockRejectedValueOnce(new Error('network down'));
    await orders.addItem('pos-1', 'demo-restaurant', 'burger');
    expect(orders.blocked).toBe(true);

    // The operator walks to POS-3, which belongs to the *other* restaurant.
    orders.clear();
    orders.useTerminal('pos-3');

    expect(orders.pending).toBeUndefined();
    expect(orders.blocked).toBe(false);

    // POS-3 is free to work, and its own mutation does not disturb POS-1's unresolved one.
    postMutationMock.mockResolvedValueOnce({
      status: 'APPLIED',
      order: snapshot('order-b', 1),
      serverVersion: 1,
    });
    await orders.createOrder('pos-3', 'second-restaurant', '9');
    expect(orders.order?.id).toBe('order-b');

    // Back at POS-1 the unresolved mutation is still there, and still retriable.
    orders.useTerminal('pos-1');
    expect(orders.pending?.terminalId).toBe('pos-1');
  });

  it('never paints another terminal answer onto the screen that replaced it', async () => {
    const orders = useOrderStore();
    orders.useTerminal('pos-1');
    orders.adopt(snapshot('order-a', 3));

    let release: (value: MutationResponse) => void = () => undefined;
    postMutationMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = orders.addItem('pos-1', 'demo-restaurant', 'burger');

    // The route changed while the request was outstanding.
    orders.clear();
    orders.useTerminal('pos-3');

    release({ status: 'APPLIED', order: snapshot('order-a', 4), serverVersion: 4 });
    await inFlight;

    // POS-3 would otherwise be showing an order from the first restaurant, and every command it
    // sent afterwards would come back CROSS_TENANT_MUTATION.
    expect(orders.order).toBeUndefined();
    // The answer still resolved the mutation: POS-1 has nothing left pending.
    orders.useTerminal('pos-1');
    expect(orders.pending).toBeUndefined();
  });
});
