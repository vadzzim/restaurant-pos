import { randomUUID } from 'node:crypto';

import type {
  AddItemPayload,
  ConflictReason,
  CreateOrderPayload,
  EventType,
  MutationResponse,
  OrderSnapshot,
  SupportedMutationType,
} from '@pos/contracts';
import {
  conflictLog,
  orders,
  outboxEvents,
  processedMutations,
  products,
  type Db,
  type Tx,
} from '@pos/db';
import { decide, type MutationCommand } from '@pos/domain';
import { eq, sql } from 'drizzle-orm';

import { ApiError, isUniqueViolation } from '../../../shared/errors.js';
import { loadOrderSnapshot } from './order-snapshot.js';
import { requestHash } from './request-hash.js';

export interface MutationInput {
  orderId: string;
  mutationId: string;
  terminalId: string;
  restaurantId: string;
  baseVersion: number;
  type: SupportedMutationType;
  payload: CreateOrderPayload | AddItemPayload | Record<string, never>;
  traceId?: string | undefined;
}

export interface MutationOutcome {
  httpStatus: number;
  body: MutationResponse;
}

/** What a successful mutation stores in `processed_mutations.result_json` (§9). */
interface StoredResult {
  order: OrderSnapshot;
  serverVersion: number;
}

/** Thrown to roll the mutation transaction back; each one maps to a §5 response. */
class CrossTenantSignal extends Error {}
class MutationIdReusedSignal extends Error {}
class ConflictSignal extends Error {
  constructor(readonly reason: ConflictReason) {
    super(reason);
  }
}
/** The order already exists with identical content, so there is nothing to apply (§21.15). */
class AlreadyAppliedSignal extends Error {}

const EVENT_TYPE_BY_MUTATION: Readonly<Record<SupportedMutationType, EventType>> = {
  CREATE_ORDER: 'OrderCreated',
  ADD_ITEM: 'OrderItemAdded',
  SEND_TO_KITCHEN: 'OrderSentToKitchen',
};

/**
 * The one write path (§5). Every order state change in the system goes through this function, in
 * a single transaction whose order of checks is §7's: tenant, idempotency, domain rules, the
 * versioned UPDATE, the effect, `processed_mutations`, `outbox_events`.
 *
 * No external call happens inside the transaction — publishing is the worker's job (§10).
 */
export async function applyMutation(db: Db, input: MutationInput): Promise<MutationOutcome> {
  const hash = requestHash(input.orderId, input.type, input.payload);

  try {
    return await db.transaction(async (tx) => runMutation(tx, input, hash));
  } catch (error) {
    if (error instanceof CrossTenantSignal) {
      // §21.11: rejected before any write, and deliberately not written to conflict_log — a
      // tenant mismatch is a rejection, not a domain conflict between two honest terminals.
      return {
        httpStatus: 403,
        body: { status: 'REJECTED', reason: 'CROSS_TENANT_MUTATION' },
      };
    }

    if (error instanceof MutationIdReusedSignal) {
      return {
        httpStatus: 409,
        body: { status: 'MUTATION_ID_REUSED', reason: 'PAYLOAD_MISMATCH' },
      };
    }

    if (error instanceof ConflictSignal) {
      return conflictOutcome(db, input, error.reason);
    }

    if (error instanceof AlreadyAppliedSignal) {
      return alreadyAppliedOutcome(db, input);
    }

    if (isUniqueViolation(error, 'processed_mutations_pkey')) {
      // A concurrent retry of the same mutation committed first. Its effect is the one that
      // counts; ours rolled back, so the business effect still happened exactly once (§21.2).
      return storedOutcome(db, input.mutationId);
    }

    throw error;
  }
}

async function runMutation(tx: Tx, input: MutationInput, hash: string): Promise<MutationOutcome> {
  const snapshot = await loadOrderSnapshot(tx, input.orderId);

  if (snapshot !== undefined && snapshot.restaurantId !== input.restaurantId) {
    throw new CrossTenantSignal();
  }

  const [processed] = await tx
    .select()
    .from(processedMutations)
    .where(eq(processedMutations.mutationId, input.mutationId))
    .limit(1);

  if (processed !== undefined) {
    if (processed.requestHash !== hash) {
      // Never return the cached result for a different request: that would silently drop a real
      // operation (§9).
      throw new MutationIdReusedSignal();
    }

    const stored = processed.resultJson as StoredResult;
    return {
      httpStatus: 200,
      body: { status: 'ALREADY_APPLIED', order: stored.order, serverVersion: stored.serverVersion },
    };
  }

  if (input.type !== 'CREATE_ORDER' && snapshot === undefined) {
    throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${input.orderId} does not exist.`);
  }

  const command = toCommand(input);
  const decision = decide(snapshot, command);

  if (decision.kind === 'conflict') {
    throw new ConflictSignal(decision.reason);
  }

  if (decision.kind === 'already-applied') {
    throw new AlreadyAppliedSignal();
  }

  const order = await applyEffect(tx, input, command);
  const result: StoredResult = { order, serverVersion: order.version };

  await tx.insert(processedMutations).values({
    mutationId: input.mutationId,
    terminalId: input.terminalId,
    orderId: input.orderId,
    requestHash: hash,
    resultJson: result,
  });

  await tx.insert(outboxEvents).values({
    id: randomUUID(),
    aggregateId: input.orderId,
    aggregateType: 'order',
    restaurantId: input.restaurantId,
    eventType: EVENT_TYPE_BY_MUTATION[input.type],
    eventVersion: order.version,
    payload: eventPayload(input, command, order),
    traceId: input.traceId ?? null,
  });

  return { httpStatus: 200, body: { status: 'APPLIED', order, serverVersion: order.version } };
}

async function applyEffect(
  tx: Tx,
  input: MutationInput,
  command: MutationCommand,
): Promise<OrderSnapshot> {
  if (command.type === 'CREATE_ORDER') {
    const inserted = await tx
      .insert(orders)
      .values({
        id: input.orderId,
        restaurantId: input.restaurantId,
        tableNumber: command.payload.tableNumber,
        status: 'OPEN',
        version: 1,
        totalCents: 0,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      // A concurrent CREATE_ORDER for the same client-generated id won the race.
      const existing = await loadOrderSnapshot(tx, input.orderId);
      if (existing?.tableNumber === command.payload.tableNumber) {
        throw new AlreadyAppliedSignal();
      }
      throw new ConflictSignal('ORDER_ALREADY_EXISTS');
    }
  } else if (command.type === 'ADD_ITEM') {
    const [product] = await tx
      .select()
      .from(products)
      .where(eq(products.id, command.payload.productId))
      .limit(1);

    if (product === undefined) {
      throw new ApiError(400, 'PRODUCT_NOT_FOUND', `Unknown product ${command.payload.productId}.`);
    }

    await guardedVersionBump(tx, input);

    await tx.execute(sql`
      insert into order_items (id, order_id, product_id, name, quantity, unit_price_cents)
      values (${randomUUID()}, ${input.orderId}, ${product.id}, ${product.name},
              ${command.payload.quantity}, ${product.priceCents})
      on conflict (order_id, product_id) do update
        set quantity = order_items.quantity + excluded.quantity, updated_at = now()
    `);

    await tx.execute(sql`
      update orders
      set total_cents = (
        select coalesce(sum(quantity * unit_price_cents), 0)
        from order_items where order_id = ${input.orderId}
      )
      where id = ${input.orderId}
    `);
  } else {
    await guardedVersionBump(tx, input, 'SENT_TO_KITCHEN');
  }

  const order = await loadOrderSnapshot(tx, input.orderId);
  if (order === undefined) {
    throw new Error(`Order ${input.orderId} vanished inside its own transaction.`);
  }
  return order;
}

/**
 * §6: the version comparison lives in the UPDATE itself. The earlier read is not a guard — two
 * transactions can both read version 5 and only one of them can bump it.
 */
async function guardedVersionBump(
  tx: Tx,
  input: MutationInput,
  nextStatus?: 'SENT_TO_KITCHEN',
): Promise<void> {
  const result =
    nextStatus === undefined
      ? await tx.execute(sql`
          update orders set version = version + 1, updated_at = now()
          where id = ${input.orderId} and version = ${input.baseVersion}
        `)
      : await tx.execute(sql`
          update orders
          set version = version + 1, status = ${nextStatus}::order_status, updated_at = now()
          where id = ${input.orderId} and version = ${input.baseVersion}
        `);

  if ((result.rowCount ?? 0) === 0) {
    throw new ConflictSignal('ORDER_VERSION_CONFLICT');
  }
}

async function conflictOutcome(
  db: Db,
  input: MutationInput,
  reason: ConflictReason,
): Promise<MutationOutcome> {
  // A concurrent retry of *this* mutation may have won the race while ours was rolling back. Its
  // effect is our effect, so answering CONFLICT would halt the client's queue (§14.1) over a
  // mutation that actually applied.
  const raced = await findProcessedMutation(db, input.mutationId);
  if (raced !== undefined) {
    return raced.requestHash === requestHash(input.orderId, input.type, input.payload)
      ? toAppliedOutcome(raced.resultJson as StoredResult)
      : { httpStatus: 409, body: { status: 'MUTATION_ID_REUSED', reason: 'PAYLOAD_MISMATCH' } };
  }

  // Read the canonical state after the rollback, so the client rebases onto what is actually
  // committed rather than onto what we saw mid-transaction.
  const canonical = await loadOrderSnapshot(db, input.orderId);
  if (canonical === undefined) {
    throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${input.orderId} does not exist.`);
  }

  await db.insert(conflictLog).values({
    id: randomUUID(),
    orderId: input.orderId,
    terminalId: input.terminalId,
    mutationId: input.mutationId,
    mutationType: input.type,
    clientBaseVersion: input.baseVersion,
    serverVersion: canonical.version,
    serverStatus: canonical.status,
    resolution: null,
  });

  return {
    httpStatus: 409,
    body: {
      status: 'CONFLICT',
      reason,
      clientBaseVersion: input.baseVersion,
      serverVersion: canonical.version,
      canonicalOrder: canonical,
    },
  };
}

/**
 * The same order id created again with identical content: no effect, but the mutation is still
 * recorded so its own retries are cheap and consistent.
 */
async function alreadyAppliedOutcome(db: Db, input: MutationInput): Promise<MutationOutcome> {
  const order = await loadOrderSnapshot(db, input.orderId);
  if (order === undefined) {
    throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${input.orderId} does not exist.`);
  }

  const result: StoredResult = { order, serverVersion: order.version };

  await db
    .insert(processedMutations)
    .values({
      mutationId: input.mutationId,
      terminalId: input.terminalId,
      orderId: input.orderId,
      requestHash: requestHash(input.orderId, input.type, input.payload),
      resultJson: result,
    })
    .onConflictDoNothing();

  return {
    httpStatus: 200,
    body: { status: 'ALREADY_APPLIED', order, serverVersion: order.version },
  };
}

async function storedOutcome(db: Db, mutationId: string): Promise<MutationOutcome> {
  const processed = await findProcessedMutation(db, mutationId);

  if (processed === undefined) {
    throw new Error(`Mutation ${mutationId} conflicted but left no processed_mutations row.`);
  }

  return toAppliedOutcome(processed.resultJson as StoredResult);
}

async function findProcessedMutation(db: Db, mutationId: string) {
  const [processed] = await db
    .select()
    .from(processedMutations)
    .where(eq(processedMutations.mutationId, mutationId))
    .limit(1);

  return processed;
}

function toAppliedOutcome(stored: StoredResult): MutationOutcome {
  return {
    httpStatus: 200,
    body: { status: 'ALREADY_APPLIED', order: stored.order, serverVersion: stored.serverVersion },
  };
}

function toCommand(input: MutationInput): MutationCommand {
  switch (input.type) {
    case 'CREATE_ORDER':
      return { type: 'CREATE_ORDER', payload: input.payload as CreateOrderPayload };
    case 'ADD_ITEM':
      return { type: 'ADD_ITEM', payload: input.payload as AddItemPayload };
    default:
      return { type: 'SEND_TO_KITCHEN', payload: {} };
  }
}

function eventPayload(
  input: MutationInput,
  command: MutationCommand,
  order: OrderSnapshot,
): Record<string, unknown> {
  if (command.type === 'CREATE_ORDER') {
    return {
      orderId: order.id,
      tableNumber: order.tableNumber,
      status: order.status,
      totalCents: order.totalCents,
    };
  }

  if (command.type === 'ADD_ITEM') {
    const item = order.items.find((candidate) => candidate.productId === command.payload.productId);
    return {
      orderId: order.id,
      productId: command.payload.productId,
      name: item?.name ?? command.payload.productId,
      quantity: command.payload.quantity,
      unitPriceCents: item?.unitPriceCents ?? 0,
      totalCents: order.totalCents,
    };
  }

  return {
    orderId: order.id,
    tableNumber: order.tableNumber,
    items: order.items,
    totalCents: order.totalCents,
  };
}
