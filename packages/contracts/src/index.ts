export const ORDER_STATUSES = [
  'OPEN',
  'SENT_TO_KITCHEN',
  'PREPARING',
  'READY',
  'PAID',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const MUTATION_TYPES = [
  'CREATE_ORDER',
  'ADD_ITEM',
  'REMOVE_ITEM',
  'CHANGE_QUANTITY',
  'SEND_TO_KITCHEN',
  'START_PREPARING',
  'MARK_READY',
  'PAY',
  'CANCEL',
] as const;

export type MutationType = (typeof MUTATION_TYPES)[number];

export interface DomainEvent<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  restaurantId: string;
  version: number;
  occurredAt: string;
  traceId?: string | undefined;
  payload: T;
}
