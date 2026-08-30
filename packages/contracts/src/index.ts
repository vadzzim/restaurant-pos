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
  /** The fake printer is switched off (§18 `Fail Printer`). A 503: retrying later is the answer. */
  'PRINTER_OFFLINE',
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
  /** Per consumer group, since M11. Empty when no admin client is configured on this instance. */
  consumerGroups: ConsumerLagReport[];
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

/**
 * The lifecycle of a `print_jobs` row (§12.3). `FAILED` is not terminal — it means the last
 * attempt failed and BullMQ is holding a retry — and `DEAD_LETTER` is: only a human moves a row
 * out of it.
 */
export const PRINT_JOB_STATES = ['PENDING', 'PRINTED', 'FAILED', 'DEAD_LETTER'] as const;

export type PrintJobState = (typeof PRINT_JOB_STATES)[number];

/** The header the fake printer deduplicates on. It carries the ticket hash (§21.14). */
export const PRINTER_IDEMPOTENCY_HEADER = 'idempotency-key';

/** What the worker posts to the fake printer: the ticket as it should appear on paper. */
export interface PrintTicketRequest {
  orderId: string;
  restaurantId: string;
  tableNumber: string;
  items: OrderItemSnapshot[];
}

/**
 * `printed: false` means the device recognised the idempotency key and did **not** emit a second
 * ticket. It is a success for the caller either way — which is the whole contract §21.14 tests.
 */
export interface PrintTicketResponse {
  receiptId: string;
  printed: boolean;
  duplicate: boolean;
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

/* ------------------------------------------------------------------------------------------- *
 * §20 observability and the §16 debug screen.
 * ------------------------------------------------------------------------------------------- */

/**
 * Where a number on `/debug` comes from, and therefore what it means when it is small.
 *
 * This travels with every counter because §20's list mixes two very different things. A `process`
 * counter is in-memory in one API instance and resets on restart; a `database` counter is derived
 * from a row that already exists and survives everything. Rendering them side by side without
 * saying which is which makes a restarted instance look like an idle system.
 *
 * `shared` is a Redis counter — the fact happens in the worker and has no row anywhere. `client`
 * is counted in the browser, because the server cannot observe an offline sync at all.
 */
export type CounterSource = 'process' | 'database' | 'shared' | 'client';

/** One §20 counter, with its provenance and, when it needs one, a caveat for the reader. */
export interface CounterReading {
  name: string;
  /** `null` means the source could not be read — a Redis outage, never a zero in disguise. */
  value: number | null;
  source: CounterSource;
  /** Present when the number means something narrower than its name suggests. */
  note?: string;
}

/**
 * A terminal Socket.IO currently holds, as Redis knows it. `pendingCount` and `offline` are
 * reported by the browser — nothing else can know them — and everything else is server-observed.
 */
export interface PresenceEntry {
  terminalId: string;
  restaurantId: string;
  role: 'pos' | 'kitchen';
  socketId: string;
  /** The client's own pending-mutation queue depth (§14). */
  pendingCount: number;
  /** The §18 per-terminal offline switch, as the browser has it. */
  offline: boolean;
  lastSeenAt: string;
}

/**
 * `GET /api/debug/metrics`. Counters and presence together because both are gauges rather than
 * stored records; every other debug endpoint returns rows.
 */
export interface MetricsResponse {
  counters: CounterReading[];
  terminals: PresenceEntry[];
  /** Why `terminals` is empty and the `shared` counters are `null`, when that is the case. */
  presenceError?: string;
  /** This API instance's uptime, so a `process` counter can be read against it. */
  processUptimeSeconds: number;
}

/** One row of `outbox_events` as `/debug` renders it (§16: dead-lettered rows included). */
export interface OutboxRowView {
  id: string;
  aggregateId: string;
  restaurantId: string;
  eventType: string;
  eventVersion: number;
  createdAt: string;
  publishedAt: string | null;
  deadLetteredAt: string | null;
  attemptCount: number;
  /** Non-zero means a publisher died holding this row; see `known-problems.md`. */
  reclaimCount: number;
  lastError: string | null;
  claimedBy: string | null;
  nextAttemptAt: string;
}

/** One row of `print_jobs` as `/debug` renders it (§16: print job state). */
export interface PrintJobRowView {
  id: string;
  orderId: string;
  restaurantId: string;
  ticketHash: string;
  state: PrintJobState;
  attemptCount: number;
  lastError: string | null;
  printedAt: string | null;
  updatedAt: string;
}

/**
 * `GET /api/debug/outbox` — the delivery view. Both halves are at-least-once pipelines with
 * attempts, a last error and a dead-letter state, and the question a human asks of them is the
 * same one: what is stuck?
 */
export interface OutboxDebugResponse {
  outbox: {
    pending: number;
    published: number;
    deadLettered: number;
    rows: OutboxRowView[];
  };
  printJobs: {
    pending: number;
    printed: number;
    failed: number;
    deadLettered: number;
    rows: PrintJobRowView[];
  };
}

/**
 * One event as the stream renders it. `consumedBy` is which consumers have recorded it, which is
 * what makes "published but the kitchen has not seen it" visible without reading two tables.
 */
export interface DebugEventView {
  eventId: string;
  eventType: string;
  aggregateId: string;
  restaurantId: string;
  version: number;
  createdAt: string;
  publishedAt: string | null;
  deadLetteredAt: string | null;
  traceId: string | null;
  consumedBy: string[];
}

export interface EventsDebugResponse {
  events: DebugEventView[];
}

/** One `conflict_log` row: versions, `mutationId`, resolution (§8, §16). */
export interface ConflictView {
  id: string;
  orderId: string;
  terminalId: string;
  mutationId: string;
  mutationType: string;
  clientBaseVersion: number;
  serverVersion: number;
  serverStatus: OrderStatus;
  resolution: string | null;
  createdAt: string;
}

export interface ConflictsDebugResponse {
  conflicts: ConflictView[];
  /** Total rows, not just the page above. */
  total: number;
  /** Rows with no resolution: a client queue still halted under §14.1. */
  unresolved: number;
}

/**
 * Committed offsets against the high watermark for one consumer group. `lag: null` means the
 * broker or the admin client could not answer — never a guessed zero, which would read as
 * "the kitchen is up to date" during exactly the outage it must not.
 */
export interface ConsumerLagReport {
  groupId: string;
  topic: string;
  lag: number | null;
  error?: string;
}

export const SHARED_COUNTER_NAMES = ['duplicateKafkaEventsPrevented'] as const;

export type SharedCounterName = (typeof SHARED_COUNTER_NAMES)[number];

/**
 * The Redis key one shared counter lives at. A pure function in `contracts` rather than a helper
 * in either app, because the API reads what the worker writes and a key spelled twice is a key
 * spelled two ways eventually.
 */
export const sharedCounterKey = (name: SharedCounterName): string => `metrics:counter:${name}`;

export const presenceKey = (terminalId: string): string => `presence:terminal:${terminalId}`;

export const PRESENCE_KEY_PATTERN = 'presence:terminal:*';

/** What the browser sends on the presence heartbeat, and on every `subscribe` (§13). */
export interface PresenceReport {
  terminalId: string;
  restaurantId: string;
  role: 'pos' | 'kitchen';
  pendingCount: number;
  offline: boolean;
}

export const PRESENCE_EVENT_NAME = 'presence';

/**
 * How often a connected browser reports its presence, and therefore how old an entry may be before
 * `/debug` marks it stale. It lives here rather than in the server's environment because the
 * browser is what sends the beat; the server's `PRESENCE_TTL_MS` is three of these, so an entry
 * survives two lost heartbeats and no more.
 */
export const PRESENCE_HEARTBEAT_MS = 5_000;

/**
 * §18's four **server-side** controls. The other seven are switches inside one browser and never
 * reach the API — see `apps/web/src/api/simulator-arms.ts` and ADR 015.
 */
export const SIMULATOR_CONTROLS = [
  'outbox-pause',
  'outbox-delay',
  'printer-fail',
  'replay-last-event',
] as const;

export type SimulatorControl = (typeof SIMULATOR_CONTROLS)[number];

/**
 * What `GET /api/debug/simulator` returns and what every `POST` returns after flipping one switch,
 * so a button never needs a second round trip to learn what it did.
 *
 * All of it is a row in PostgreSQL: fleet-wide, and it survives a worker restart. That lifetime is
 * the interesting part and `/debug` states it next to the controls.
 */
export interface SimulatorState {
  outbox: {
    paused: boolean;
    publishDelayMs: number;
  };
  printer: {
    failing: boolean;
  };
}

/** The one event a replay put back in flight, or `null` when nothing has been published yet. */
export interface ReplayedEventView {
  eventId: string;
  eventType: string;
  aggregateId: string;
  eventVersion: number;
  /** When it was published the first time. It is unpublished again as of this response. */
  previouslyPublishedAt: string;
}

/**
 * The largest `publish_delay_ms` a publisher can honour and still publish anything.
 *
 * A delay that eats the whole lease budget before the first send turns every pass into claim,
 * wait, release, publish nothing — a pause wearing a delay's clothes, and an undocumented one.
 * Half the budget is the ceiling: the other half has to cover the claim's round trip and the send
 * itself, which is the thing the delay exists to make visible.
 *
 * Shared rather than the publisher's own, because three processes need the same number: the worker
 * that honours it, the CLI that validates a typed value, and the API that validates a clicked one.
 * `OUTBOX_LEASE_SAFETY_FRACTION` is how much of the lease a pass refuses to spend — publishing
 * right up to `claim_until` is publishing under a lease another worker may already have taken.
 */
export const OUTBOX_LEASE_SAFETY_FRACTION = 0.1;

export const maxPublishDelayMs = (leaseMs: number): number =>
  Math.floor((leaseMs * (1 - OUTBOX_LEASE_SAFETY_FRACTION)) / 2);

export interface SimulatorResponse {
  state: SimulatorState;
  /** Present only on `replay-last-event`. */
  replayed?: ReplayedEventView | null;
}
