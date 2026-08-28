import type { MenuItem, MutationType, OrderSnapshot } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import { menuLookup, nextBaseVersion, projectQueue } from '../src/domain/project-queue';
import type { PendingMutationRecord } from '../src/persistence/db';

const MENU: MenuItem[] = [
  { id: 'burger', name: 'Burger', priceCents: 1200 },
  { id: 'cola', name: 'Cola', priceCents: 300 },
];

const lookup = menuLookup(MENU);

function snapshot(version: number, overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: 'order-1',
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status: 'OPEN',
    version,
    totalCents: 0,
    items: [],
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
    ...overrides,
  };
}

let sequence = 0;

function queued(
  type: MutationType,
  baseVersion: number,
  payload: Record<string, unknown> = {},
): PendingMutationRecord {
  sequence += 1;
  return {
    mutationId: `m-${sequence}`,
    restaurantId: 'demo-restaurant',
    terminalId: 'pos-1',
    orderId: 'order-1',
    baseVersion,
    type,
    payload: payload as PendingMutationRecord['payload'],
    createdAt: `2026-08-28T10:00:0${sequence}.000Z`,
    status: 'PENDING',
  };
}

describe('the optimistic projection', () => {
  it('builds an order that exists only in this client, from its CREATE_ORDER', () => {
    // §19.2: creating an order while disconnected works, because creation is a mutation like any
    // other. Nothing canonical exists yet, and the screen still has to show the order.
    const projected = projectQueue(
      undefined,
      [
        queued('CREATE_ORDER', 0, { tableNumber: '7' }),
        queued('ADD_ITEM', 1, { productId: 'burger', quantity: 2 }),
        queued('ADD_ITEM', 2, { productId: 'cola', quantity: 1 }),
      ],
      lookup,
    );

    expect(projected?.tableNumber).toBe('7');
    expect(projected?.items).toEqual([
      { productId: 'burger', name: 'Burger', quantity: 2, unitPriceCents: 1200 },
      { productId: 'cola', name: 'Cola', quantity: 1, unitPriceCents: 300 },
    ]);
    expect(projected?.totalCents).toBe(2700);
    expect(projected?.version).toBe(3);
  });

  it('adds to an existing line rather than making a second one', () => {
    const projected = projectQueue(
      snapshot(5, {
        items: [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }],
        totalCents: 1200,
      }),
      [queued('ADD_ITEM', 5, { productId: 'burger', quantity: 2 })],
      lookup,
    );

    expect(projected?.items).toHaveLength(1);
    expect(projected?.items[0]?.quantity).toBe(3);
    expect(projected?.totalCents).toBe(3600);
  });

  it('takes a change of quantity as the absolute value and a removal as a removal', () => {
    const projected = projectQueue(
      snapshot(5, {
        items: [{ productId: 'burger', name: 'Burger', quantity: 4, unitPriceCents: 1200 }],
      }),
      [
        queued('CHANGE_QUANTITY', 5, { productId: 'burger', quantity: 2 }),
        queued('ADD_ITEM', 6, { productId: 'cola', quantity: 1 }),
        queued('REMOVE_ITEM', 7, { productId: 'burger' }),
      ],
      lookup,
    );

    expect(projected?.items).toEqual([
      { productId: 'cola', name: 'Cola', quantity: 1, unitPriceCents: 300 },
    ]);
    expect(projected?.totalCents).toBe(300);
  });

  it('moves the status, and refuses what §8 refuses', () => {
    const projected = projectQueue(
      snapshot(5),
      [
        queued('CANCEL', 5, {}),
        // Queued behind a cancellation. The operator should not watch a line appear on an order
        // this client already believes is cancelled — `decide()` says no, and it is the same
        // function the server will answer with.
        queued('ADD_ITEM', 6, { productId: 'burger', quantity: 1 }),
      ],
      lookup,
    );

    expect(projected?.status).toBe('CANCELLED');
    expect(projected?.items).toEqual([]);
  });

  it('still shows a line for a product the menu has not loaded, priced at zero', () => {
    const projected = projectQueue(
      snapshot(5),
      [queued('ADD_ITEM', 5, { productId: 'mystery', quantity: 1 })],
      lookup,
    );

    expect(projected?.items[0]).toEqual({
      productId: 'mystery',
      name: 'mystery',
      quantity: 1,
      unitPriceCents: 0,
    });
  });

  it('leaves the canonical snapshot untouched when there is nothing queued', () => {
    const canonical = snapshot(5);
    expect(projectQueue(canonical, [], lookup)).toBe(canonical);
  });
});

describe('nextBaseVersion', () => {
  it('is the projected version, so a queued mutation assumes the one in front of it applied', () => {
    // This is what makes §19.2 drain cleanly: A at 5 produces v6, so B is stamped at 6 and the
    // server produces exactly that. Stamping from the canonical version would conflict B against
    // A's own success.
    const canonical = snapshot(5);
    expect(nextBaseVersion(canonical)).toBe(5);
    expect(
      nextBaseVersion(
        projectQueue(
          canonical,
          [queued('ADD_ITEM', 5, { productId: 'cola', quantity: 1 })],
          lookup,
        ),
      ),
    ).toBe(6);
  });

  it('is 0 when there is no order at all — a CREATE_ORDER asserts the order does not exist', () => {
    expect(nextBaseVersion(undefined)).toBe(0);
  });
});
