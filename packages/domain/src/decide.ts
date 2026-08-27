import type {
  AddItemPayload,
  ConflictReason,
  CreateOrderPayload,
  OrderSnapshot,
  OrderStatus,
  SendToKitchenPayload,
} from '@pos/contracts';

import { isValidTransition } from './status.js';

export type MutationCommand =
  | { type: 'CREATE_ORDER'; payload: CreateOrderPayload }
  | { type: 'ADD_ITEM'; payload: AddItemPayload }
  | { type: 'SEND_TO_KITCHEN'; payload: SendToKitchenPayload };

export type Decision =
  /** The mutation may proceed; the versioned UPDATE is still the guard that decides the race. */
  | { kind: 'apply'; nextStatus: OrderStatus }
  /** Already reflected in server state and semantically safe to treat as a repeat (§8). */
  | { kind: 'already-applied' }
  | { kind: 'conflict'; reason: ConflictReason };

/**
 * The single place that answers "may this mutation apply to the order as it currently stands?"
 *
 * It deliberately knows nothing about versions: staleness is caught by the SQL guard in §6, and
 * mixing the two here would hide which check actually rejected a mutation. A domain conflict is
 * returned even when the version also matches, because "the kitchen is already cooking" is a
 * better answer than "your version is old".
 *
 * A missing order for a non-creating mutation is not represented here — that is ORDER_NOT_FOUND,
 * an HTTP concern of the caller.
 */
export function decide(order: OrderSnapshot | undefined, command: MutationCommand): Decision {
  if (command.type === 'CREATE_ORDER') {
    if (order === undefined) {
      return { kind: 'apply', nextStatus: 'OPEN' };
    }

    // Same orderId, same content, different mutationId: the client retried a creation whose
    // response it lost. Returning the existing order is safe; different content is not (§21.15).
    return order.tableNumber === command.payload.tableNumber
      ? { kind: 'already-applied' }
      : { kind: 'conflict', reason: 'ORDER_ALREADY_EXISTS' };
  }

  if (order === undefined) {
    throw new Error(`decide() requires an existing order for ${command.type}`);
  }

  const blocked = blockingStatusConflict(order.status);
  if (blocked !== undefined) {
    return { kind: 'conflict', reason: blocked };
  }

  if (command.type === 'ADD_ITEM') {
    // Items cannot change once the kitchen has the order. This is the rule the offline conflict
    // demo rests on, so it is a hard reject rather than a merge (§8).
    return order.status === 'OPEN'
      ? { kind: 'apply', nextStatus: order.status }
      : { kind: 'conflict', reason: 'ORDER_ALREADY_SENT_TO_KITCHEN' };
  }

  if (order.status !== 'OPEN') {
    return { kind: 'conflict', reason: 'ORDER_ALREADY_SENT_TO_KITCHEN' };
  }

  return isValidTransition(order.status, 'SENT_TO_KITCHEN')
    ? { kind: 'apply', nextStatus: 'SENT_TO_KITCHEN' }
    : { kind: 'conflict', reason: 'INVALID_STATUS_TRANSITION' };
}

function blockingStatusConflict(status: OrderStatus): ConflictReason | undefined {
  if (status === 'CANCELLED') {
    return 'ORDER_CANCELLED';
  }
  if (status === 'PAID') {
    return 'ORDER_ALREADY_PAID';
  }
  return undefined;
}
