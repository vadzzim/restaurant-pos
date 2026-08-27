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

/** The three types the M3 vertical slice implements end to end. M5 adds the rest. */
export const SUPPORTED_MUTATION_TYPES = ['CREATE_ORDER', 'ADD_ITEM', 'SEND_TO_KITCHEN'] as const;

export type SupportedMutationType = (typeof SUPPORTED_MUTATION_TYPES)[number];

export const EVENT_TYPES = [
  'OrderCreated',
  'OrderItemAdded',
  'OrderItemRemoved',
  'OrderQuantityChanged',
  'OrderSentToKitchen',
  'OrderPreparing',
  'OrderReady',
  'OrderPaid',
  'OrderCancelled',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

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

export interface OrderItemSnapshot {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderSnapshot {
  id: string;
  restaurantId: string;
  tableNumber: string;
  status: OrderStatus;
  version: number;
  totalCents: number;
  items: OrderItemSnapshot[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderCreatedPayload {
  orderId: string;
  tableNumber: string;
  status: OrderStatus;
  totalCents: number;
}

export interface OrderItemAddedPayload {
  orderId: string;
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

export interface OrderSentToKitchenPayload {
  orderId: string;
  tableNumber: string;
  items: OrderItemSnapshot[];
  totalCents: number;
}

export interface CreateOrderPayload {
  tableNumber: string;
}

export interface AddItemPayload {
  productId: string;
  quantity: number;
}

export type SendToKitchenPayload = Record<string, never>;

export interface MutationRequest {
  mutationId: string;
  terminalId: string;
  restaurantId: string;
  baseVersion: number;
  type: SupportedMutationType;
  payload: CreateOrderPayload | AddItemPayload | SendToKitchenPayload;
}

/**
 * Why a mutation could not be applied. Version conflicts and domain conflicts are distinct: the
 * client can rebase from the former, while the latter means the operation no longer makes sense.
 */
export const CONFLICT_REASONS = [
  'ORDER_VERSION_CONFLICT',
  'ORDER_CANCELLED',
  'ORDER_ALREADY_PAID',
  'ORDER_ALREADY_SENT_TO_KITCHEN',
  'ORDER_ALREADY_EXISTS',
  'INVALID_STATUS_TRANSITION',
] as const;

export type ConflictReason = (typeof CONFLICT_REASONS)[number];

export interface MutationAppliedResponse {
  status: 'APPLIED' | 'ALREADY_APPLIED';
  order: OrderSnapshot;
  serverVersion: number;
}

export interface MutationConflictResponse {
  status: 'CONFLICT';
  reason: ConflictReason;
  clientBaseVersion: number;
  serverVersion: number;
  canonicalOrder: OrderSnapshot;
}

export interface MutationIdReusedResponse {
  status: 'MUTATION_ID_REUSED';
  reason: 'PAYLOAD_MISMATCH';
}

export interface MutationRejectedResponse {
  status: 'REJECTED';
  reason: 'CROSS_TENANT_MUTATION';
}

export type MutationResponse =
  | MutationAppliedResponse
  | MutationConflictResponse
  | MutationIdReusedResponse
  | MutationRejectedResponse;

/** The §17 error envelope. Domain outcomes above are not errors and never use this shape. */
export interface ApiErrorResponse {
  code: string;
  message: string;
  details?: unknown;
}
