import type { MenuItem, MutationType, OrderSnapshot, OrderStatus } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import {
  affordances,
  conflictHeadline,
  coverNoun,
  coversFor,
  menuFor,
  menuTiles,
} from '../src/domain/pos-screen';
import type { PendingMutationRecord, PendingMutationStatus } from '../src/persistence/db';

const MENU: MenuItem[] = [
  { id: 'burger', name: 'Burger', priceCents: 1200 },
  { id: 'pizza', name: 'Pizza', priceCents: 1500 },
  { id: 'cola', name: 'Cola', priceCents: 300 },
  { id: 'draft-beer', name: 'Draft Beer', priceCents: 700 },
];

function snapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: 'order-1',
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status: 'OPEN',
    version: 3,
    totalCents: 0,
    items: [],
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
    ...overrides,
  };
}

function row(
  type: MutationType,
  status: PendingMutationStatus,
  mutationId = `m-${type}-${status}`,
): PendingMutationRecord {
  return {
    mutationId,
    restaurantId: 'demo-restaurant',
    terminalId: 'pos-1',
    orderId: 'order-1',
    baseVersion: 3,
    type,
    payload: {},
    createdAt: '2026-08-28T10:00:00.000Z',
    status,
  };
}

describe('menuFor', () => {
  it('gives a dining terminal the whole menu', () => {
    expect(menuFor(MENU, 'dining').map((item) => item.id)).toEqual([
      'burger',
      'pizza',
      'cola',
      'draft-beer',
    ]);
  });

  it('gives a bar terminal only what BAR_MENU names', () => {
    expect(menuFor(MENU, 'bar').map((item) => item.id)).toEqual(['cola', 'draft-beer']);
  });

  it('falls back to the whole menu rather than showing an empty bar', () => {
    // An empty till reads as broken; a misconfigured filter should degrade to too much, not to
    // nothing, because the operator can still work with too much.
    const food: MenuItem[] = [{ id: 'burger', name: 'Burger', priceCents: 1200 }];
    expect(menuFor(food, 'bar')).toEqual(food);
  });

  it('returns a copy rather than the caller array', () => {
    const result = menuFor(MENU, 'dining');
    result.pop();
    expect(MENU).toHaveLength(4);
  });
});

describe('menuTiles', () => {
  it('carries the quantity already on the ticket', () => {
    const tiles = menuTiles(
      MENU,
      'dining',
      snapshot({
        items: [
          { productId: 'burger', name: 'Burger', quantity: 3, unitPriceCents: 1200 },
          { productId: 'cola', name: 'Cola', quantity: 1, unitPriceCents: 300 },
        ],
        totalCents: 3900,
      }),
    );

    expect(tiles.map((tile) => [tile.id, tile.count])).toEqual([
      ['burger', 3],
      ['pizza', 0],
      ['cola', 1],
      ['draft-beer', 0],
    ]);
  });

  it('is all zeroes before an order exists', () => {
    expect(menuTiles(MENU, 'dining', undefined).every((tile) => tile.count === 0)).toBe(true);
  });

  it('counts against the bar menu too', () => {
    const tiles = menuTiles(
      MENU,
      'bar',
      snapshot({
        items: [{ productId: 'draft-beer', name: 'Draft Beer', quantity: 2, unitPriceCents: 700 }],
      }),
    );
    expect(tiles).toEqual([
      { id: 'cola', name: 'Cola', priceCents: 300, count: 0 },
      { id: 'draft-beer', name: 'Draft Beer', priceCents: 700, count: 2 },
    ]);
  });
});

describe('affordances', () => {
  it('allows nothing without an order', () => {
    expect(affordances(undefined, false)).toEqual({
      order: false,
      pay: false,
      cancel: false,
      send: false,
    });
  });

  it('allows nothing while the queue is halted, whatever the status says', () => {
    expect(affordances(snapshot({ status: 'OPEN' }), true)).toEqual({
      order: false,
      pay: false,
      cancel: false,
      send: false,
    });
  });

  it('freezes the items once the kitchen has the order', () => {
    for (const status of ['SENT_TO_KITCHEN', 'PREPARING', 'READY'] satisfies OrderStatus[]) {
      expect(affordances(snapshot({ status }), false).order).toBe(false);
    }
  });

  it('permits payment from OPEN and READY and from nowhere else', () => {
    const paid = (status: OrderStatus): boolean => affordances(snapshot({ status }), false).pay;
    expect([paid('OPEN'), paid('READY')]).toEqual([true, true]);
    expect([paid('SENT_TO_KITCHEN'), paid('PREPARING'), paid('PAID'), paid('CANCELLED')]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('refuses to send an empty order', () => {
    expect(affordances(snapshot({ items: [] }), false).send).toBe(false);
    expect(
      affordances(
        snapshot({
          items: [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }],
        }),
        false,
      ).send,
    ).toBe(true);
  });

  it('stops offering cancel once the order is finished', () => {
    expect(affordances(snapshot({ status: 'PAID' }), false).cancel).toBe(false);
    expect(affordances(snapshot({ status: 'CANCELLED' }), false).cancel).toBe(false);
    expect(affordances(snapshot({ status: 'PREPARING' }), false).cancel).toBe(true);
  });
});

describe('conflictHeadline', () => {
  const conflict = {
    reason: 'ORDER_VERSION_CONFLICT',
    clientBaseVersion: 3,
    serverVersion: 5,
  } as const;

  it('is absent when there is no conflict', () => {
    expect(conflictHeadline(undefined, [])).toBeUndefined();
  });

  it('names the conflicted mutation and counts only what is blocked behind it', () => {
    expect(
      conflictHeadline(conflict, [
        row('ADD_ITEM', 'CONFLICT'),
        row('CHANGE_QUANTITY', 'BLOCKED'),
        row('REMOVE_ITEM', 'BLOCKED'),
      ]),
    ).toEqual({
      reason: 'ORDER_VERSION_CONFLICT',
      mutationType: 'ADD_ITEM',
      clientBaseVersion: 3,
      serverVersion: 5,
      blockedCount: 2,
    });
  });

  it('does not count the conflicted mutation as blocked behind itself', () => {
    expect(conflictHeadline(conflict, [row('ADD_ITEM', 'CONFLICT')])?.blockedCount).toBe(0);
  });

  it('survives a queue that has already been drained', () => {
    expect(conflictHeadline(conflict, [])).toEqual({
      reason: 'ORDER_VERSION_CONFLICT',
      mutationType: undefined,
      clientBaseVersion: 3,
      serverVersion: 5,
      blockedCount: 0,
    });
  });
});

describe('covers', () => {
  it('runs tabs at the bar and tables on the floor', () => {
    expect(coverNoun('bar')).toBe('Tab');
    expect(coverNoun('dining')).toBe('Table');
  });

  it('carries no noun of its own, on either profile', () => {
    // The screen renders `${coverNoun(profile)} ${cover}` on the button and again in the heading.
    // A cover of `Tab 2` produced `Tab Tab 2` there — caught in the browser, fixed here.
    for (const profile of ['bar', 'dining'] as const) {
      expect(coversFor(profile).every((cover) => /^\d+$/.test(cover))).toBe(true);
    }
  });
});
