import type { DomainEvent } from '@pos/contracts';

/** The §13 room names. The client never sends one of these; the server derives them. */
export const restaurantRoom = (restaurantId: string): string => `restaurant:${restaurantId}`;
export const orderRoom = (orderId: string): string => `order:${orderId}`;
export const kitchenRoom = (restaurantId: string): string => `kitchen:${restaurantId}`;

/**
 * The events that change what the kitchen screen renders. It reads `kitchen_tickets`, so an event
 * that moves no ticket must not reach the kitchen room: the screen would refetch, find nothing new
 * and — because it waits for the projection to catch up — spend its whole retry budget on an event
 * that was never going to appear.
 *
 * M5 adds `OrderPreparing`, `OrderReady` and `OrderCancelled` here, at the same time as it teaches
 * the kitchen consumer to advance `state` from them.
 */
const KITCHEN_EVENT_TYPES = new Set(['OrderSentToKitchen']);

/**
 * Where one event has to land. A socket in several of these rooms still receives one copy —
 * Socket.IO deduplicates across the rooms named in a single emit.
 */
export function roomsFor(event: DomainEvent): string[] {
  const rooms = [orderRoom(event.aggregateId), restaurantRoom(event.restaurantId)];

  if (KITCHEN_EVENT_TYPES.has(event.eventType)) {
    rooms.push(kitchenRoom(event.restaurantId));
  }

  return rooms;
}

/** The seam the realtime consumer writes to, so it can be tested without a socket server. */
export interface RealtimeEmitter {
  emit(rooms: string[], event: DomainEvent): void;
}
