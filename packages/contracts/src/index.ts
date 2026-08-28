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

export interface OrderItemRemovedPayload {
  orderId: string;
  productId: string;
  totalCents: number;
}

export interface OrderQuantityChangedPayload {
  orderId: string;
  productId: string;
  quantity: number;
  totalCents: number;
}

export interface OrderSentToKitchenPayload {
  orderId: string;
  tableNumber: string;
  items: OrderItemSnapshot[];
  totalCents: number;
}

/** `OrderPreparing`, `OrderReady` and `OrderCancelled` all carry this: a status and nothing more. */
export interface OrderStatusChangedPayload {
  orderId: string;
  tableNumber: string;
  status: OrderStatus;
}

export interface OrderPaidPayload {
  orderId: string;
  amountCents: number;
  method: PaymentMethod;
}

export interface CreateOrderPayload {
  tableNumber: string;
}

export interface AddItemPayload {
  productId: string;
  quantity: number;
}

export type SendToKitchenPayload = Record<string, never>;

export interface RemoveItemPayload {
  productId: string;
}

export interface ChangeQuantityPayload {
  productId: string;
  quantity: number;
}

export const PAYMENT_METHODS = ['CASH', 'CARD'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * No amount. Money comes from the order's canonical `total_cents`, read inside the mutation's own
 * transaction — a client-supplied amount would be a second source of truth for money, and the
 * version guard already refuses a payment built on a total that has since moved.
 */
export interface PayPayload {
  method: PaymentMethod;
}

export interface CancelPayload {
  reason?: string | undefined;
}

export type StartPreparingPayload = Record<string, never>;

export type MarkReadyPayload = Record<string, never>;

export type MutationPayload =
  | CreateOrderPayload
  | AddItemPayload
  | RemoveItemPayload
  | ChangeQuantityPayload
  | SendToKitchenPayload
  | StartPreparingPayload
  | MarkReadyPayload
  | PayPayload
  | CancelPayload;

export interface MutationRequest {
  mutationId: string;
  terminalId: string;
  restaurantId: string;
  baseVersion: number;
  type: MutationType;
  payload: MutationPayload;
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
  'ITEM_NOT_IN_ORDER',
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

/**
 * Every code the §17 error envelope can carry. Deliberately closed and deliberately small: a
 * conflict, a tenant rejection and an id reuse are §5 *outcomes* with a snapshot and a reason, not
 * errors, and routing them through this envelope would throw both away. §17's example happens to
 * name `ORDER_VERSION_CONFLICT`; §5 defines the response the client actually branches on.
 */
export const API_ERROR_CODES = [
  /** The request did not satisfy its zod schema, or its body was not parseable at all. */
  'VALIDATION_FAILED',
  'ORDER_NOT_FOUND',
  /** The menu has no such product. A bad request, not a conflict: no version rebase would help. */
  'PRODUCT_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The §17 error envelope. Domain outcomes above are not errors and never use this shape. */
export interface ApiErrorResponse {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

/** `GET /api/health/live` — the process answers, and nothing else is claimed (§17). */
export interface LivenessResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export type DependencyStatus = 'up' | 'down';

/**
 * Hard means readiness depends on it; soft means the system degrades and keeps accepting orders.
 * The distinction is the whole content of the health split, so it travels with every report.
 */
export type DependencyKind = 'hard' | 'soft';

export interface DependencyReport {
  name: string;
  kind: DependencyKind;
  status: DependencyStatus;
  latencyMs: number;
  /** Present only when `status` is `down`. Never a stack trace (§17). */
  error?: string;
  /** What being down costs, in one sentence, for whoever is reading `/debug`. */
  impact: string;
}

/**
 * `ok` — everything is up. `degraded` — only soft dependencies are down: live updates suffer,
 * writes do not. `unavailable` — a hard dependency is down and this instance cannot accept writes.
 */
export type HealthStatus = 'ok' | 'degraded' | 'unavailable';

/**
 * `GET /api/health/ready`: PostgreSQL only (§17). The same shape on 200 and on 503, so a failing
 * probe is readable rather than generic.
 */
export interface ReadinessResponse {
  status: Extract<HealthStatus, 'ok' | 'unavailable'>;
  checks: DependencyReport[];
}

/** The outbox seen from outside: what "the broker is down" costs, as a number. */
export interface OutboxBacklog {
  pending: number;
  deadLettered: number;
  oldestPendingAgeSeconds: number | null;
}

/** `GET /api/debug/dependencies` (§17) — what `/debug` renders and what a human reads. */
export interface DependenciesResponse {
  status: HealthStatus;
  dependencies: DependencyReport[];
  outbox: OutboxBacklog;
}

export interface MenuItem {
  id: string;
  name: string;
  priceCents: number;
}

/**
 * What a ticket can be. It is not `OrderStatus`: the projection only ever learns about the events
 * that reach the kitchen, so `OPEN` and `PAID` have no ticket state and never will.
 */
export const KITCHEN_TICKET_STATES = [
  'SENT_TO_KITCHEN',
  'PREPARING',
  'READY',
  'CANCELLED',
] as const;

export type KitchenTicketState = (typeof KITCHEN_TICKET_STATES)[number];

/** One row of the kitchen projection (§12.1), as the kitchen screen reads it. */
export interface KitchenTicket {
  orderId: string;
  restaurantId: string;
  tableNumber: string;
  items: OrderItemSnapshot[];
  state: KitchenTicketState;
  sourceEventVersion: number;
  createdAt: string;
  updatedAt: string;
}

export const FEATURE_FLAG_KEYS = ['realtime.websocket_push'] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

/** `GET /api/config`: the flag state resolved for one restaurant (§15, §17). */
export interface ConfigResponse {
  restaurantId: string;
  flags: Record<FeatureFlagKey, boolean>;
}

/**
 * One event name carrying one envelope, so the client writes its dedup and version gate once
 * instead of per event type (§12.2).
 */
export const REALTIME_EVENT_NAME = 'order.event';

export const SUBSCRIBE_EVENT_NAME = 'subscribe';

/**
 * What a client asks to follow. It names its restaurant, its role and its current order — never a
 * raw room string; the server derives room membership from this (§13).
 */
export interface SubscribeRequest {
  restaurantId: string;
  role: 'pos' | 'kitchen';
  orderId?: string | undefined;
}

export interface TerminalDescriptor {
  id: string;
  restaurantId: string;
  label: string;
}

/**
 * The demo terminals. This lives in contracts rather than in the seed alone because both sides
 * need it: the database seeds these rows, and the client resolves the restaurant it belongs to
 * from the terminal id in the URL. `pos-3` sits in the second restaurant on purpose — it is what
 * makes the tenant boundary and the §15 rollout visible on screen.
 */
export const TERMINALS: readonly TerminalDescriptor[] = [
  { id: 'pos-1', restaurantId: 'demo-restaurant', label: 'POS-1' },
  { id: 'pos-2', restaurantId: 'demo-restaurant', label: 'POS-2' },
  { id: 'bar-1', restaurantId: 'demo-restaurant', label: 'BAR-1' },
  { id: 'pos-3', restaurantId: 'second-restaurant', label: 'POS-3' },
];

/**
 * The kitchen display is not one of the four seeded terminals — it belongs to a room, not to a
 * till. Nothing has a foreign key to `terminals`, and a terminal id is only ever a label in
 * `processed_mutations` and `conflict_log`, so a constant is enough (§5, and see ADR 012).
 */
export const KITCHEN_TERMINAL_ID = 'kitchen-display';

export function findTerminal(terminalId: string): TerminalDescriptor | undefined {
  return TERMINALS.find((terminal) => terminal.id === terminalId);
}
