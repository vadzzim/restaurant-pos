import type { OrderSnapshot } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import { acceptsSnapshot, sameMutation, type MutationIdentity } from '../src/stores/order';

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

describe('acceptsSnapshot (out-of-order refetches)', () => {
  it('takes anything when nothing is held', () => {
    expect(acceptsSnapshot(undefined, snapshot('a', 4))).toBe(true);
  });

  it('takes a newer version', () => {
    expect(acceptsSnapshot(snapshot('a', 3), snapshot('a', 4))).toBe(true);
  });

  it('refuses an older response that lost the race back', () => {
    // Two refetches were in flight; the one that started first answered last.
    expect(acceptsSnapshot(snapshot('a', 5), snapshot('a', 4))).toBe(false);
  });

  it('takes a different order regardless of version', () => {
    expect(acceptsSnapshot(snapshot('a', 9), snapshot('b', 1))).toBe(true);
  });
});

describe('sameMutation (retrying with the same identity)', () => {
  const pending: MutationIdentity = {
    orderId: 'order-1',
    mutationId: 'mutation-1',
    type: 'ADD_ITEM',
    baseVersion: 3,
    payload: { productId: 'burger', quantity: 1 },
  };

  it('recognises the identical attempt', () => {
    expect(
      sameMutation(pending, 'ADD_ITEM', 'order-1', 3, { productId: 'burger', quantity: 1 }),
    ).toBe(true);
  });

  it('rejects a different payload, order, version or type', () => {
    expect(
      sameMutation(pending, 'ADD_ITEM', 'order-1', 3, { productId: 'cola', quantity: 1 }),
    ).toBe(false);
    expect(
      sameMutation(pending, 'ADD_ITEM', 'order-2', 3, { productId: 'burger', quantity: 1 }),
    ).toBe(false);
    expect(
      sameMutation(pending, 'ADD_ITEM', 'order-1', 4, { productId: 'burger', quantity: 1 }),
    ).toBe(false);
    expect(
      sameMutation(pending, 'SEND_TO_KITCHEN', 'order-1', 3, { productId: 'burger', quantity: 1 }),
    ).toBe(false);
  });

  it('matches a CREATE_ORDER retry, which has no orderId to compare yet', () => {
    const create: MutationIdentity = {
      orderId: 'order-9',
      mutationId: 'mutation-9',
      type: 'CREATE_ORDER',
      baseVersion: 0,
      payload: { tableNumber: '12' },
    };

    // The point of the match: the retry reuses `order-9` instead of minting a second order.
    expect(sameMutation(create, 'CREATE_ORDER', undefined, 0, { tableNumber: '12' })).toBe(true);
    expect(sameMutation(create, 'CREATE_ORDER', undefined, 0, { tableNumber: '13' })).toBe(false);
  });

  it('never matches when nothing is pending', () => {
    expect(sameMutation(undefined, 'CREATE_ORDER', undefined, 0, { tableNumber: '12' })).toBe(
      false,
    );
  });
});
