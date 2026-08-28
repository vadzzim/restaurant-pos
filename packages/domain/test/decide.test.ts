import { ORDER_STATUSES, type OrderSnapshot, type OrderStatus } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import {
  calculateTotalCents,
  decide,
  isValidTransition,
  type Decision,
  type MutationCommand,
} from '../src/index.js';

const BURGER = { productId: 'burger', name: 'Burger', quantity: 2, unitPriceCents: 1200 };

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

/** An order that actually has a line, so the item rules have something to be about. */
function orderWithBurger(status: OrderStatus): OrderSnapshot {
  return { ...order(status), items: [BURGER], totalCents: 2400 };
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

/**
 * §8 as a table. Every non-creating mutation against every status, written out rather than
 * derived, so a rule that changes has to be changed here too — a matrix generated from the same
 * code it checks proves only that the code agrees with itself.
 *
 * The order under test has one line, so the item rules are exercised against something real; the
 * two cases that turn on an *absent* line are asserted separately below.
 */
const COMMANDS = {
  ADD_ITEM: { type: 'ADD_ITEM', payload: { productId: 'cola', quantity: 1 } },
  REMOVE_ITEM: { type: 'REMOVE_ITEM', payload: { productId: 'burger' } },
  CHANGE_QUANTITY: { type: 'CHANGE_QUANTITY', payload: { productId: 'burger', quantity: 5 } },
  SEND_TO_KITCHEN: { type: 'SEND_TO_KITCHEN', payload: {} },
  START_PREPARING: { type: 'START_PREPARING', payload: {} },
  MARK_READY: { type: 'MARK_READY', payload: {} },
  PAY: { type: 'PAY', payload: { method: 'CARD' } },
  CANCEL: { type: 'CANCEL', payload: {} },
} as const satisfies Record<string, MutationCommand>;

type CommandName = keyof typeof COMMANDS;

const apply = (nextStatus: OrderStatus): Decision => ({ kind: 'apply', nextStatus });
const sent: Decision = { kind: 'conflict', reason: 'ORDER_ALREADY_SENT_TO_KITCHEN' };
const outOfOrder: Decision = { kind: 'conflict', reason: 'INVALID_STATUS_TRANSITION' };
const paid: Decision = { kind: 'conflict', reason: 'ORDER_ALREADY_PAID' };
const cancelled: Decision = { kind: 'conflict', reason: 'ORDER_CANCELLED' };

const MATRIX: Record<OrderStatus, Record<CommandName, Decision>> = {
  OPEN: {
    ADD_ITEM: apply('OPEN'),
    REMOVE_ITEM: apply('OPEN'),
    CHANGE_QUANTITY: apply('OPEN'),
    SEND_TO_KITCHEN: apply('SENT_TO_KITCHEN'),
    START_PREPARING: outOfOrder,
    MARK_READY: outOfOrder,
    PAY: apply('PAID'),
    CANCEL: apply('CANCELLED'),
  },
  SENT_TO_KITCHEN: {
    ADD_ITEM: sent,
    REMOVE_ITEM: sent,
    CHANGE_QUANTITY: sent,
    SEND_TO_KITCHEN: sent,
    START_PREPARING: apply('PREPARING'),
    MARK_READY: outOfOrder,
    PAY: outOfOrder,
    CANCEL: apply('CANCELLED'),
  },
  PREPARING: {
    ADD_ITEM: sent,
    REMOVE_ITEM: sent,
    CHANGE_QUANTITY: sent,
    SEND_TO_KITCHEN: sent,
    START_PREPARING: outOfOrder,
    MARK_READY: apply('READY'),
    PAY: outOfOrder,
    CANCEL: apply('CANCELLED'),
  },
  READY: {
    ADD_ITEM: sent,
    REMOVE_ITEM: sent,
    CHANGE_QUANTITY: sent,
    SEND_TO_KITCHEN: sent,
    START_PREPARING: outOfOrder,
    MARK_READY: outOfOrder,
    PAY: apply('PAID'),
    CANCEL: apply('CANCELLED'),
  },
  PAID: {
    ADD_ITEM: paid,
    REMOVE_ITEM: paid,
    CHANGE_QUANTITY: paid,
    SEND_TO_KITCHEN: paid,
    START_PREPARING: paid,
    MARK_READY: paid,
    PAY: paid,
    CANCEL: paid,
  },
  CANCELLED: {
    ADD_ITEM: cancelled,
    REMOVE_ITEM: cancelled,
    CHANGE_QUANTITY: cancelled,
    SEND_TO_KITCHEN: cancelled,
    START_PREPARING: cancelled,
    MARK_READY: cancelled,
    PAY: cancelled,
    // §8's CANCELLED reject list names seven types and CANCEL is not one of them: the intent is
    // already satisfied, so this is the "idempotent where semantically safe" case.
    CANCEL: { kind: 'already-applied' },
  },
};

describe('the §8 conflict matrix', () => {
  for (const status of ORDER_STATUSES) {
    for (const name of Object.keys(COMMANDS) as CommandName[]) {
      it(`${status} + ${name}`, () => {
        expect(decide(orderWithBurger(status), COMMANDS[name])).toEqual(MATRIX[status][name]);
      });
    }
  }

  it('covers every status and every non-creating mutation type', () => {
    expect(Object.keys(MATRIX)).toHaveLength(ORDER_STATUSES.length);
    expect(Object.keys(COMMANDS)).toHaveLength(8);
  });
});

describe('the rules that turn on the item rather than the status', () => {
  it('treats removing a line that is not there as already applied', () => {
    expect(decide(orderWithBurger('OPEN'), COMMANDS.REMOVE_ITEM)).toEqual(apply('OPEN'));
    expect(
      decide(orderWithBurger('OPEN'), { type: 'REMOVE_ITEM', payload: { productId: 'cola' } }),
    ).toEqual({ kind: 'already-applied' });
  });

  it('conflicts when a quantity change names a line the order does not have', () => {
    expect(
      decide(orderWithBurger('OPEN'), {
        type: 'CHANGE_QUANTITY',
        payload: { productId: 'cola', quantity: 2 },
      }),
    ).toEqual({ kind: 'conflict', reason: 'ITEM_NOT_IN_ORDER' });
  });

  it('still applies a quantity change to the quantity already stored', () => {
    // The version guard is what decides a concurrent quantity race (§8); a value comparison here
    // would be a second mechanism answering the same question.
    expect(
      decide(orderWithBurger('OPEN'), {
        type: 'CHANGE_QUANTITY',
        payload: { productId: 'burger', quantity: BURGER.quantity },
      }),
    ).toEqual(apply('OPEN'));
  });
});
