import type { KitchenTicket, OrderSnapshot } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import { ticketsSatisfy } from '../src/stores/kitchen';
import { acceptsSnapshot } from '../src/domain/order-snapshot';

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

describe('ticketsSatisfy (has the projection caught up?)', () => {
  const ticket = (orderId: string, sourceEventVersion: number): KitchenTicket => ({
    orderId,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    items: [],
    state: 'SENT_TO_KITCHEN',
    sourceEventVersion,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  });

  it('is trivially satisfied when nothing was expected', () => {
    expect(ticketsSatisfy([], [])).toBe(true);
  });

  it('needs every expectation of the round, not just one', () => {
    const rows = [ticket('a', 3)];
    expect(ticketsSatisfy(rows, [{ orderId: 'a', version: 3 }])).toBe(true);
    expect(
      ticketsSatisfy(rows, [
        { orderId: 'a', version: 3 },
        { orderId: 'b', version: 2 },
      ]),
    ).toBe(false);
  });

  it('refuses a ticket the projection has not advanced far enough', () => {
    expect(ticketsSatisfy([ticket('a', 2)], [{ orderId: 'a', version: 3 }])).toBe(false);
    expect(ticketsSatisfy([ticket('a', 4)], [{ orderId: 'a', version: 3 }])).toBe(true);
  });
});
