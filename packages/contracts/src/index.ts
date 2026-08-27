export type OrderStatus = 'OPEN' | 'SENT_TO_KITCHEN' | 'PREPARING' | 'READY' | 'PAID' | 'CANCELLED';

export type MutationType =
  | 'CREATE_ORDER'
  | 'ADD_ITEM'
  | 'REMOVE_ITEM'
  | 'CHANGE_QUANTITY'
  | 'SEND_TO_KITCHEN'
  | 'START_PREPARING'
  | 'MARK_READY'
  | 'PAY'
  | 'CANCEL';

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
