import type { DomainEvent } from '@pos/contracts';

/** The §13 room names. The client never sends one of these; the server derives them. */
export const restaurantRoom = (restaurantId: string): string => `restaurant:${restaurantId}`;
export const orderRoom = (orderId: string): string => `order:${orderId}`;
export const kitchenRoom = (restaurantId: string): string => `kitchen:${restaurantId}`;

/**
 * Where one event has to land. A socket in several of these rooms still receives one copy —
 * Socket.IO deduplicates across the rooms named in a single emit.
 */
export function roomsFor(event: DomainEvent): string[] {
  const rooms = [orderRoom(event.aggregateId), restaurantRoom(event.restaurantId)];

  if (event.eventType === 'OrderSentToKitchen') {
    rooms.push(kitchenRoom(event.restaurantId));
  }

  return rooms;
}

/** The seam the realtime consumer writes to, so it can be tested without a socket server. */
export interface RealtimeEmitter {
  emit(rooms: string[], event: DomainEvent): void;
}
