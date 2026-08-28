import type {
  DomainEvent,
  KitchenTicket,
  KitchenTicketState,
  MutationResponse,
  OrderSnapshot,
  OrderStatus,
} from '@pos/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchTickets, postKitchenCommand } from '../src/api/client';
import { expectationFor, nextCommand, useKitchenStore } from '../src/stores/kitchen';

vi.mock('../src/api/client', () => ({
  fetchTickets: vi.fn(),
  postKitchenCommand: vi.fn(),
}));

const fetchTicketsMock = vi.mocked(fetchTickets);
const postKitchenCommandMock = vi.mocked(postKitchenCommand);

function ticket(
  orderId: string,
  state: KitchenTicketState,
  sourceEventVersion: number,
): KitchenTicket {
  return {
    orderId,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    items: [{ productId: 'burger', name: 'Burger', quantity: 1, unitPriceCents: 1200 }],
    state,
    sourceEventVersion,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

const order = (version: number, status: OrderStatus): OrderSnapshot => ({
  id: 'order-a',
  restaurantId: 'demo-restaurant',
  tableNumber: '12',
  status,
  version,
  totalCents: 1200,
  items: [],
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
});

const applied = (serverVersion: number): MutationResponse => ({
  status: 'APPLIED',
  serverVersion,
  order: order(serverVersion, 'PREPARING'),
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

describe('nextCommand', () => {
  it('offers one command per state, and none once the ticket is done', () => {
    expect(nextCommand('SENT_TO_KITCHEN')).toBe('preparing');
    expect(nextCommand('PREPARING')).toBe('ready');
    expect(nextCommand('READY')).toBeUndefined();
    expect(nextCommand('CANCELLED')).toBeUndefined();
  });
});

describe('a kitchen command', () => {
  it('is sent at the version the projection knows, and waits for the projection to catch up', async () => {
    const kitchen = useKitchenStore();
    fetchTicketsMock.mockResolvedValue([ticket('order-a', 'SENT_TO_KITCHEN', 6)]);
    await kitchen.load('demo-restaurant');

    postKitchenCommandMock.mockResolvedValueOnce(applied(7));
    fetchTicketsMock.mockResolvedValue([ticket('order-a', 'PREPARING', 7)]);

    await kitchen.command('order-a', 'preparing');

    // `baseVersion` is the ticket's source_event_version — the order version the event carried.
    expect(postKitchenCommandMock).toHaveBeenCalledWith(
      'order-a',
      'preparing',
      expect.objectContaining({ baseVersion: 6, restaurantId: 'demo-restaurant' }),
    );
    expect(kitchen.tickets[0]?.state).toBe('PREPARING');
    expect(kitchen.lagging).toBe(false);
  });

  it('shows a refusal on the card and refetches without waiting for a version', async () => {
    const kitchen = useKitchenStore();
    fetchTicketsMock.mockResolvedValue([ticket('order-a', 'SENT_TO_KITCHEN', 6)]);
    await kitchen.load('demo-restaurant');

    // Another display got there first: the projection was one version behind (ADR 012).
    postKitchenCommandMock.mockResolvedValueOnce({
      status: 'CONFLICT',
      reason: 'INVALID_STATUS_TRANSITION',
      clientBaseVersion: 6,
      serverVersion: 7,
      canonicalOrder: order(7, 'PREPARING'),
    });
    fetchTicketsMock.mockResolvedValue([ticket('order-a', 'PREPARING', 7)]);

    await kitchen.command('order-a', 'preparing');

    expect(kitchen.conflictByOrder.get('order-a')).toBe('INVALID_STATUS_TRANSITION');
    expect(kitchen.pendingByOrder.has('order-a')).toBe(false);
    expect(kitchen.tickets[0]?.state).toBe('PREPARING');
  });
});

describe('a kitchen command with no answer', () => {
  it('holds the ticket, retries with the same mutationId, and leaves other tickets working', async () => {
    const kitchen = useKitchenStore();
    fetchTicketsMock.mockResolvedValue([
      ticket('order-a', 'SENT_TO_KITCHEN', 6),
      ticket('order-b', 'SENT_TO_KITCHEN', 4),
    ]);
    await kitchen.load('demo-restaurant');

    postKitchenCommandMock.mockRejectedValueOnce(new Error('network down'));
    await kitchen.command('order-a', 'preparing');

    const held = kitchen.pendingByOrder.get('order-a');
    expect(held?.command).toBe('preparing');
    expect(kitchen.commandError).toMatch(/network down/i);

    // One stuck ticket must not blind the rail: order-b still takes commands.
    postKitchenCommandMock.mockResolvedValueOnce(applied(5));
    await kitchen.command('order-b', 'preparing');
    expect(postKitchenCommandMock).toHaveBeenLastCalledWith(
      'order-b',
      'preparing',
      expect.objectContaining({ baseVersion: 4 }),
    );

    // Reusing the id is what turns a lost response into ALREADY_APPLIED under §9.
    postKitchenCommandMock.mockResolvedValueOnce(applied(7));
    await kitchen.retry('order-a');

    expect(postKitchenCommandMock).toHaveBeenLastCalledWith(
      'order-a',
      'preparing',
      expect.objectContaining({ mutationId: held?.mutationId, baseVersion: 6 }),
    );
    expect(kitchen.pendingByOrder.has('order-a')).toBe(false);
  });

  it('refuses a different command for the same ticket while one is unresolved', async () => {
    const kitchen = useKitchenStore();
    fetchTicketsMock.mockResolvedValue([ticket('order-a', 'PREPARING', 6)]);
    await kitchen.load('demo-restaurant');

    postKitchenCommandMock.mockRejectedValueOnce(new Error('network down'));
    await kitchen.command('order-a', 'ready');
    expect(postKitchenCommandMock).toHaveBeenCalledTimes(1);

    await kitchen.command('order-a', 'preparing');

    expect(postKitchenCommandMock).toHaveBeenCalledTimes(1);
    expect(kitchen.commandError).toMatch(/no answer yet/i);
  });

  it('drops the identity only when the operator says so', async () => {
    const kitchen = useKitchenStore();
    fetchTicketsMock.mockResolvedValue([ticket('order-a', 'SENT_TO_KITCHEN', 6)]);
    await kitchen.load('demo-restaurant');

    postKitchenCommandMock.mockRejectedValueOnce(new Error('network down'));
    await kitchen.command('order-a', 'preparing');
    expect(kitchen.pendingByOrder.has('order-a')).toBe(true);

    kitchen.discard('order-a');

    expect(kitchen.pendingByOrder.has('order-a')).toBe(false);
    expect(kitchen.commandError).toBeUndefined();
  });
});

describe('expectationFor (what the projection may be asked to catch up to)', () => {
  const event = (eventType: string, aggregateId: string, version: number): DomainEvent => ({
    eventId: 'e1',
    eventType,
    aggregateId,
    restaurantId: 'demo-restaurant',
    version,
    occurredAt: '2026-08-28T00:00:00.000Z',
    payload: {},
  });

  it('waits for a ticket that the event is going to create', () => {
    expect(expectationFor(event('OrderSentToKitchen', 'order-a', 4), [])).toEqual({
      orderId: 'order-a',
      version: 4,
    });
  });

  it('waits for a ticket it already holds to advance', () => {
    const held = [ticket('order-a', 'SENT_TO_KITCHEN', 4)];
    expect(expectationFor(event('OrderPreparing', 'order-a', 5), held)).toEqual({
      orderId: 'order-a',
      version: 5,
    });
  });

  it('waits for a transition whose ticket has not reached this screen yet', () => {
    // The case that matters most, and the one the first version of this rule got wrong. A
    // transition always concerns a ticket that exists — START_PREPARING requires SENT_TO_KITCHEN,
    // MARK_READY requires PREPARING — so an empty `held` means the projection is behind, which is
    // exactly what the wait is for. Skipping it here spends the event's only hint and leaves the
    // rail in the previous column until another event or a reload.
    expect(expectationFor(event('OrderPreparing', 'order-a', 5), [])).toEqual({
      orderId: 'order-a',
      version: 5,
    });
    expect(expectationFor(event('OrderReady', 'order-a', 6), [])).toEqual({
      orderId: 'order-a',
      version: 6,
    });
    // Nor does holding some *other* order's ticket make a difference.
    expect(
      expectationFor(event('OrderReady', 'order-a', 6), [ticket('order-b', 'PREPARING', 2)]),
    ).toEqual({ orderId: 'order-a', version: 6 });
  });

  it('expects nothing from a cancellation for an order the kitchen never saw', () => {
    // CANCEL is valid on an OPEN order, so this event legitimately has no ticket to move. Asking
    // the projection for one would burn the whole retry budget and raise PROJECTION LAG over a
    // row that is never going to be written.
    expect(expectationFor(event('OrderCancelled', 'order-z', 2), [])).toBeUndefined();
    expect(
      expectationFor(event('OrderCancelled', 'order-z', 2), [
        ticket('order-a', 'SENT_TO_KITCHEN', 4),
      ]),
    ).toBeUndefined();
  });

  it('still waits when a cancellation concerns a ticket on the rail', () => {
    const held = [ticket('order-a', 'PREPARING', 5)];
    expect(expectationFor(event('OrderCancelled', 'order-a', 6), held)).toEqual({
      orderId: 'order-a',
      version: 6,
    });
  });
});

describe('the review found: a load that can never converge', () => {
  it('does not report projection lag for a cancellation with no ticket', async () => {
    const kitchen = useKitchenStore();
    fetchTicketsMock.mockResolvedValue([ticket('order-a', 'SENT_TO_KITCHEN', 4)]);
    await kitchen.load('demo-restaurant');

    const cancelled: DomainEvent = {
      eventId: 'e2',
      eventType: 'OrderCancelled',
      aggregateId: 'order-z',
      restaurantId: 'demo-restaurant',
      version: 2,
      occurredAt: '2026-08-28T00:00:00.000Z',
      payload: {},
    };

    fetchTicketsMock.mockClear();
    await kitchen.load('demo-restaurant', expectationFor(cancelled, kitchen.tickets));

    // One read, no retry storm, no banner.
    expect(fetchTicketsMock).toHaveBeenCalledTimes(1);
    expect(kitchen.lagging).toBe(false);
  });
});
