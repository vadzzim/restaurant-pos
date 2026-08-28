import { randomUUID } from 'node:crypto';

import type {
  AddItemPayload,
  CancelPayload,
  ChangeQuantityPayload,
  ConflictReason,
  CreateOrderPayload,
  EventType,
  MutationPayload,
  MutationResponse,
  MutationType,
  OrderSnapshot,
  OrderStatus,
  PayPayload,
  RemoveItemPayload,
} from '@pos/contracts';
import {
  conflictLog,
  orders,
  outboxEvents,
  payments,
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
  type: MutationType;
  payload: MutationPayload;
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

const EVENT_TYPE_BY_MUTATION: Readonly<Record<MutationType, EventType>> = {
  CREATE_ORDER: 'OrderCreated',
  ADD_ITEM: 'OrderItemAdded',
  REMOVE_ITEM: 'OrderItemRemoved',
  CHANGE_QUANTITY: 'OrderQuantityChanged',
  SEND_TO_KITCHEN: 'OrderSentToKitchen',
  START_PREPARING: 'OrderPreparing',
  MARK_READY: 'OrderReady',
  PAY: 'OrderPaid',
  CANCEL: 'OrderCancelled',
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
      return alreadyAppliedOutcome(db, input, hash);
    }

    if (isUniqueViolation(error, 'processed_mutations_pkey')) {
      // A mutation with this id committed while ours was in flight. If it carried the same
      // request, its effect is our effect and the business effect happened exactly once (§21.2).
      // If it carried a different one, this is id reuse and returning the winner's result would
      // silently drop a real operation (§9) — so the hash decides, exactly as it does above.
      return racedOutcome(db, input, hash);
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

  const order = await applyEffect(tx, input, command, decision.nextStatus, snapshot);
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

/**
 * The write half of the mutation. Everything that is not a creation bumps the version under the
 * §6 guard *first*, so a stale mutation rolls back before it can touch an item, a payment or a
 * status, and only then applies whatever else it changes.
 */
async function applyEffect(
  tx: Tx,
  input: MutationInput,
  command: MutationCommand,
  nextStatus: OrderStatus,
  current: OrderSnapshot | undefined,
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
      // A concurrent CREATE_ORDER for the same client-generated id won the race. The tenant check
      // at the top of the transaction saw no order at all, so it has to run again here — the
      // winner may belong to another restaurant, and answering ALREADY_APPLIED would hand this
      // caller another tenant's order (§3).
      const existing = await loadOrderSnapshot(tx, input.orderId);
      if (existing !== undefined && existing.restaurantId !== input.restaurantId) {
        throw new CrossTenantSignal();
      }
      if (existing?.tableNumber === command.payload.tableNumber) {
        throw new AlreadyAppliedSignal();
      }
      throw new ConflictSignal('ORDER_ALREADY_EXISTS');
    }
  } else if (current === undefined) {
    // runMutation refuses a missing order for every non-creating mutation before this point.
    throw new Error(`Order ${input.orderId} disappeared between the read and the write.`);
  } else {
    await guardedVersionBump(tx, input, nextStatus);
    await applyChange(tx, input, command, current);
  }

  const order = await loadOrderSnapshot(tx, input.orderId);
  if (order === undefined) {
    throw new Error(`Order ${input.orderId} vanished inside its own transaction.`);
  }
  return order;
}

/**
 * What each command changes beyond the status and the version. Four of the nine change nothing
 * else — `SEND_TO_KITCHEN`, `START_PREPARING`, `MARK_READY` and `CANCEL` are pure transitions.
 */
async function applyChange(
  tx: Tx,
  input: MutationInput,
  command: Exclude<MutationCommand, { type: 'CREATE_ORDER' }>,
  current: OrderSnapshot,
): Promise<void> {
  switch (command.type) {
    case 'ADD_ITEM': {
      const [product] = await tx
        .select()
        .from(products)
        .where(eq(products.id, command.payload.productId))
        .limit(1);

      if (product === undefined) {
        throw new ApiError(
          400,
          'PRODUCT_NOT_FOUND',
          `Unknown product ${command.payload.productId}.`,
        );
      }

      await tx.execute(sql`
        insert into order_items (id, order_id, product_id, name, quantity, unit_price_cents)
        values (${randomUUID()}, ${input.orderId}, ${product.id}, ${product.name},
                ${command.payload.quantity}, ${product.priceCents})
        on conflict (order_id, product_id) do update
          set quantity = order_items.quantity + excluded.quantity, updated_at = now()
      `);

      return recalculateTotal(tx, input.orderId);
    }

    case 'REMOVE_ITEM': {
      await tx.execute(sql`
        delete from order_items
        where order_id = ${input.orderId} and product_id = ${command.payload.productId}
      `);

      return recalculateTotal(tx, input.orderId);
    }

    case 'CHANGE_QUANTITY': {
      await tx.execute(sql`
        update order_items set quantity = ${command.payload.quantity}, updated_at = now()
        where order_id = ${input.orderId} and product_id = ${command.payload.productId}
      `);

      return recalculateTotal(tx, input.orderId);
    }

    case 'PAY': {
      // The amount is the order's own total, read in this transaction and guarded by the version
      // bump above. A client-supplied amount would be a second source of truth for money, and
      // `payments.mutation_id` is unique so a repeat cannot insert a second row (§21.9).
      await tx.insert(payments).values({
        id: randomUUID(),
        orderId: input.orderId,
        mutationId: input.mutationId,
        amountCents: current.totalCents,
        method: command.payload.method,
      });
      return;
    }

    default:
      return;
  }
}

/**
 * The total is derived from the lines, never accumulated. Money is integer cents, and summing in
 * SQL from the rows that exist is the one arithmetic that cannot drift from them.
 */
async function recalculateTotal(tx: Tx, orderId: string): Promise<void> {
  await tx.execute(sql`
    update orders
    set total_cents = (
      select coalesce(sum(quantity * unit_price_cents), 0)
      from order_items where order_id = ${orderId}
    )
    where id = ${orderId}
  `);
}

/**
 * §6: the version comparison lives in the UPDATE itself. The earlier read is not a guard — two
 * transactions can both read version 5 and only one of them can bump it.
 */
async function guardedVersionBump(
  tx: Tx,
  input: MutationInput,
  nextStatus: OrderStatus,
): Promise<void> {
  // `decide()` returns the status the order should end in, which for an item mutation is the one
  // it already has. Writing it unconditionally keeps one statement for all eight cases.
  const result = await tx.execute(sql`
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
    return outcomeFor(raced, requestHash(input.orderId, input.type, input.payload));
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
 * A mutation whose intent is already satisfied by server state (§8): the same order created again
 * with identical content, a line removed that is not there, an order cancelled twice. Nothing is
 * applied and the version does not move, but the mutation is still recorded so its own retries are
 * cheap and consistent, and the caller gets the canonical order to rebase on.
 *
 * **This is the one answer in the system that asserts something about state without writing it**,
 * so there is no versioned UPDATE here for §6 to protect — and the state it asserts can move
 * underneath it. The decision was taken in a transaction that then rolled back: a `REMOVE_ITEM`
 * for a line the order does not have can be overtaken by an `ADD_ITEM` for that very product,
 * which commits in the gap. Answering `ALREADY_APPLIED` then hands the caller a canonical order
 * still containing the line they asked to remove, and tells them their removal is reflected in it.
 *
 * So the order row is locked and the decision is taken again under that lock. The lock is narrow
 * on purpose — this path writes one row, calls nothing external, and is the only pessimistic lock
 * in the write path. Everywhere else optimism is correct because there is a write to guard.
 */
async function alreadyAppliedOutcome(
  db: Db,
  input: MutationInput,
  hash: string,
): Promise<MutationOutcome> {
  const settled = await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from orders where id = ${input.orderId} for update`);

    const order = await loadOrderSnapshot(tx, input.orderId);
    if (order === undefined) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${input.orderId} does not exist.`);
    }

    const verdict = decide(order, toCommand(input));
    if (verdict.kind !== 'already-applied') {
      // The world moved between the decision and this acknowledgement. `apply` means the
      // operation is meaningful again — at a version this client no longer holds; `conflict`
      // means it is now refused for a reason worth naming instead.
      return verdict.kind === 'conflict' ? verdict.reason : ('ORDER_VERSION_CONFLICT' as const);
    }

    const result: StoredResult = { order, serverVersion: order.version };

    await tx
      .insert(processedMutations)
      .values({
        mutationId: input.mutationId,
        terminalId: input.terminalId,
        orderId: input.orderId,
        requestHash: hash,
        resultJson: result,
      })
      .onConflictDoNothing();

    return {
      httpStatus: 200,
      body: { status: 'ALREADY_APPLIED', order, serverVersion: order.version },
    } satisfies MutationOutcome;
  });

  return typeof settled === 'string' ? conflictOutcome(db, input, settled) : settled;
}

async function racedOutcome(db: Db, input: MutationInput, hash: string): Promise<MutationOutcome> {
  const processed = await findProcessedMutation(db, input.mutationId);

  if (processed === undefined) {
    throw new Error(
      `Mutation ${input.mutationId} hit the processed_mutations primary key but left no row.`,
    );
  }

  return outcomeFor(processed, hash);
}

function outcomeFor(
  processed: { requestHash: string; resultJson: unknown },
  hash: string,
): MutationOutcome {
  if (processed.requestHash !== hash) {
    return { httpStatus: 409, body: { status: 'MUTATION_ID_REUSED', reason: 'PAYLOAD_MISMATCH' } };
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

/**
 * The boundary has already validated the payload against the branch its `type` selects (zod, in
 * `mutation-routes.ts`), so this is the one place the two are re-joined into the domain's tagged
 * union. The casts are that validation being spent, not an assumption being made.
 */
function toCommand(input: MutationInput): MutationCommand {
  switch (input.type) {
    case 'CREATE_ORDER':
      return { type: 'CREATE_ORDER', payload: input.payload as CreateOrderPayload };
    case 'ADD_ITEM':
      return { type: 'ADD_ITEM', payload: input.payload as AddItemPayload };
    case 'REMOVE_ITEM':
      return { type: 'REMOVE_ITEM', payload: input.payload as RemoveItemPayload };
    case 'CHANGE_QUANTITY':
      return { type: 'CHANGE_QUANTITY', payload: input.payload as ChangeQuantityPayload };
    case 'SEND_TO_KITCHEN':
      return { type: 'SEND_TO_KITCHEN', payload: {} };
    case 'START_PREPARING':
      return { type: 'START_PREPARING', payload: {} };
    case 'MARK_READY':
      return { type: 'MARK_READY', payload: {} };
    case 'PAY':
      return { type: 'PAY', payload: input.payload as PayPayload };
    case 'CANCEL':
      return { type: 'CANCEL', payload: input.payload as CancelPayload };
  }
}

/**
 * The §11 payload of the event this mutation produced, built from the order as it now stands. A
 * consumer still treats an event as a hint and reads canonical state itself (§12, §13); the
 * payload exists so the kitchen projection and `/debug` have something to show without a join.
 */
function eventPayload(
  input: MutationInput,
  command: MutationCommand,
  order: OrderSnapshot,
): Record<string, unknown> {
  switch (command.type) {
    case 'CREATE_ORDER':
      return {
        orderId: order.id,
        tableNumber: order.tableNumber,
        status: order.status,
        totalCents: order.totalCents,
      };

    case 'ADD_ITEM': {
      const item = order.items.find((line) => line.productId === command.payload.productId);
      return {
        orderId: order.id,
        productId: command.payload.productId,
        name: item?.name ?? command.payload.productId,
        quantity: command.payload.quantity,
        unitPriceCents: item?.unitPriceCents ?? 0,
        totalCents: order.totalCents,
      };
    }

    case 'REMOVE_ITEM':
      return {
        orderId: order.id,
        productId: command.payload.productId,
        totalCents: order.totalCents,
      };

    case 'CHANGE_QUANTITY':
      return {
        orderId: order.id,
        productId: command.payload.productId,
        quantity: command.payload.quantity,
        totalCents: order.totalCents,
      };

    case 'SEND_TO_KITCHEN':
      return {
        orderId: order.id,
        tableNumber: order.tableNumber,
        items: order.items,
        totalCents: order.totalCents,
      };

    case 'PAY':
      return {
        orderId: order.id,
        amountCents: order.totalCents,
        method: command.payload.method,
      };

    // START_PREPARING, MARK_READY and CANCEL are pure transitions: the new status is the news.
    default:
      return {
        orderId: order.id,
        tableNumber: order.tableNumber,
        status: order.status,
      };
  }
}
