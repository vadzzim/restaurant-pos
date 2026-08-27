import type { OrderSnapshot, OrderStatus } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import { calculateTotalCents, decide, isValidTransition } from '../src/index.js';

function order(status: OrderStatus, tableNumber = '12'): OrderSnapshot {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    restaurantId: 'demo-restaurant',
    tableNumber,
    status,
    version: 3,
    totalCents: 0,
    items: [],
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
  };
}

const addItem = { type: 'ADD_ITEM', payload: { productId: 'burger', quantity: 1 } } as const;
const sendToKitchen = { type: 'SEND_TO_KITCHEN', payload: {} } as const;

describe('calculateTotalCents', () => {
  it('sums quantity times unit price in integer cents', () => {
    expect(
      calculateTotalCents([
        { productId: 'burger', name: 'Burger', quantity: 2, unitPriceCents: 1200 },
        { productId: 'cola', name: 'Cola', quantity: 3, unitPriceCents: 300 },
      ]),
    ).toBe(3300);
  });

  it('is zero for an empty order', () => {
    expect(calculateTotalCents([])).toBe(0);
  });
});

describe('isValidTransition', () => {
  it('allows the kitchen path and refuses to leave a terminal status', () => {
    expect(isValidTransition('OPEN', 'SENT_TO_KITCHEN')).toBe(true);
    expect(isValidTransition('SENT_TO_KITCHEN', 'PREPARING')).toBe(true);
    expect(isValidTransition('OPEN', 'PREPARING')).toBe(false);
    expect(isValidTransition('PAID', 'CANCELLED')).toBe(false);
  });
});

describe('decide', () => {
  it('creates an order that does not exist yet', () => {
    expect(decide(undefined, { type: 'CREATE_ORDER', payload: { tableNumber: '12' } })).toEqual({
      kind: 'apply',
      nextStatus: 'OPEN',
    });
  });

  it('treats a repeated creation with identical content as already applied', () => {
    expect(decide(order('OPEN'), { type: 'CREATE_ORDER', payload: { tableNumber: '12' } })).toEqual(
      { kind: 'already-applied' },
    );
  });

  it('conflicts when the same order id is created with different content', () => {
    expect(decide(order('OPEN'), { type: 'CREATE_ORDER', payload: { tableNumber: '13' } })).toEqual(
      { kind: 'conflict', reason: 'ORDER_ALREADY_EXISTS' },
    );
  });

  it('rejects item changes once the kitchen has the order', () => {
    expect(decide(order('SENT_TO_KITCHEN'), addItem)).toEqual({
      kind: 'conflict',
      reason: 'ORDER_ALREADY_SENT_TO_KITCHEN',
    });
  });

  it('reports the domain reason rather than a generic conflict on cancelled and paid orders', () => {
    expect(decide(order('CANCELLED'), addItem)).toEqual({
      kind: 'conflict',
      reason: 'ORDER_CANCELLED',
    });
    expect(decide(order('PAID'), sendToKitchen)).toEqual({
      kind: 'conflict',
      reason: 'ORDER_ALREADY_PAID',
    });
  });

  it('sends an open order to the kitchen exactly once', () => {
    expect(decide(order('OPEN'), sendToKitchen)).toEqual({
      kind: 'apply',
      nextStatus: 'SENT_TO_KITCHEN',
    });
    expect(decide(order('PREPARING'), sendToKitchen)).toEqual({
      kind: 'conflict',
      reason: 'ORDER_ALREADY_SENT_TO_KITCHEN',
    });
  });
});
