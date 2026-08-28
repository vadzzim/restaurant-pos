import { ORDER_STATUSES } from '@pos/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The order lifecycle is the one status set the whole system agrees on, so it is a real
 * PostgreSQL enum generated from the contracts tuple. Consumer-owned states (kitchen tickets,
 * print jobs) stay `text` — they are still being shaped by later milestones.
 */
export const orderStatus = pgEnum('order_status', ORDER_STATUSES);

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const restaurants = pgTable('restaurants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt,
});

export const terminals = pgTable(
  'terminals',
  {
    id: text('id').primaryKey(),
    restaurantId: text('restaurant_id')
      .notNull()
      .references(() => restaurants.id),
    label: text('label').notNull(),
    createdAt,
  },
  (table) => [index('terminals_restaurant_id_idx').on(table.restaurantId)],
);

export const products = pgTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  createdAt,
});

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    restaurantId: text('restaurant_id')
      .notNull()
      .references(() => restaurants.id),
    tableNumber: text('table_number').notNull(),
    status: orderStatus('status').notNull().default('OPEN'),
    version: integer('version').notNull().default(1),
    totalCents: integer('total_cents').notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('orders_restaurant_id_idx').on(table.restaurantId),
    index('orders_status_idx').on(table.status),
  ],
);

/**
 * One product is one line whose quantity changes, which is what makes ADD_ITEM an upsert and
 * gives CHANGE_QUANTITY and REMOVE_ITEM a stable target (spec §8).
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [unique('order_items_order_id_product_id_key').on(table.orderId, table.productId)],
);

/**
 * `mutation_id` is unique so a repeated PAY cannot insert a second payment even if the
 * idempotency check above it were bypassed (spec §21.9).
 */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id),
  mutationId: uuid('mutation_id').notNull().unique(),
  amountCents: integer('amount_cents').notNull(),
  method: text('method').notNull(),
  createdAt,
});

/**
 * The idempotency record of spec §9. `order_id` is intentionally not a foreign key: the record of
 * "this mutation was already applied" must outlive the row it touched.
 */
export const processedMutations = pgTable('processed_mutations', {
  mutationId: uuid('mutation_id').primaryKey(),
  terminalId: text('terminal_id').notNull(),
  orderId: uuid('order_id').notNull(),
  requestHash: text('request_hash').notNull(),
  resultJson: jsonb('result_json').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `id` is the `eventId` of the §11 envelope; `processed_events.event_id` refers to exactly this
 * value. `restaurant_id` and `trace_id` are stored on the row because the publisher runs outside
 * the mutation transaction and cannot reconstruct the envelope by joining back to `orders`.
 * `claimed_by` / `claim_until` are the §10 lease.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    restaurantId: text('restaurant_id').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull(),
    payload: jsonb('payload').notNull(),
    traceId: text('trace_id'),
    createdAt,
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    claimUntil: timestamp('claim_until', { withTimezone: true }),
    /**
     * How many times a *previous* claimant's lease expired on this row. A reclaim means a worker
     * died mid-publish, not that the event is bad, so it never spends an `attempt_count` and never
     * dead-letters (ADR 010) — but a row being reclaimed over and over is the only visible symptom
     * of a publisher crashing on it, so it is counted rather than left silent.
     */
    reclaimCount: integer('reclaim_count').notNull().default(0),
  },
  (table) => [
    index('outbox_events_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`published_at is null and dead_lettered_at is null`),
  ],
);

export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').notNull(),
    consumerName: text('consumer_name').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.consumerName] })],
);

/** The kitchen read model built by the kitchen consumer (spec §12.1). */
export const kitchenTickets = pgTable(
  'kitchen_tickets',
  {
    orderId: uuid('order_id').primaryKey(),
    restaurantId: text('restaurant_id')
      .notNull()
      .references(() => restaurants.id),
    tableNumber: text('table_number').notNull(),
    items: jsonb('items').notNull(),
    state: text('state').notNull(),
    sourceEventVersion: integer('source_event_version').notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [index('kitchen_tickets_restaurant_id_state_idx').on(table.restaurantId, table.state)],
);

/** Every rejected mutation is recorded here and shown in /debug (spec §8). */
export const conflictLog = pgTable('conflict_log', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  terminalId: text('terminal_id').notNull(),
  mutationId: uuid('mutation_id').notNull(),
  mutationType: text('mutation_type').notNull(),
  clientBaseVersion: integer('client_base_version').notNull(),
  serverVersion: integer('server_version').notNull(),
  serverStatus: orderStatus('server_status').notNull(),
  resolution: text('resolution'),
  createdAt,
});

/**
 * The two §18 switches the outbox publisher honours: `Pause Outbox Publisher` and
 * `Delay Outbox Publishing`. They live in PostgreSQL because the process that flips them (the API,
 * once M12 gives them buttons) is not the process that obeys them, and because a switch a human
 * threw must survive a worker restart — an environment variable satisfies neither.
 *
 * One row, `id = 'singleton'`: the publisher is a fleet-wide component, not a per-restaurant one.
 * A missing row reads as the defaults, so nothing has to seed it.
 */
export const outboxControls = pgTable(
  'outbox_controls',
  {
    id: text('id').primaryKey(),
    paused: boolean('paused').notNull().default(false),
    publishDelayMs: integer('publish_delay_ms').notNull().default(0),
    updatedAt,
  },
  (table) => [check('outbox_controls_singleton', sql`${table.id} = 'singleton'`)],
);

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  rolloutPercent: integer('rollout_percent').notNull().default(0),
  updatedAt,
});

/**
 * The durable record behind the BullMQ print job (spec §12.3). It records what we believe was
 * printed; it cannot know what physically emerged from the device.
 */
export const printJobs = pgTable('print_jobs', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  ticketHash: text('ticket_hash').notNull().unique(),
  state: text('state').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt,
  updatedAt,
});
