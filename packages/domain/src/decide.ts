import type {
  AddItemPayload,
  CancelPayload,
  ChangeQuantityPayload,
  ConflictReason,
  CreateOrderPayload,
  MarkReadyPayload,
  OrderSnapshot,
  OrderStatus,
  PayPayload,
  RemoveItemPayload,
  SendToKitchenPayload,
  StartPreparingPayload,
} from '@pos/contracts';

import { isValidTransition } from './status.js';

export type MutationCommand =
  | { type: 'CREATE_ORDER'; payload: CreateOrderPayload }
  | { type: 'ADD_ITEM'; payload: AddItemPayload }
  | { type: 'REMOVE_ITEM'; payload: RemoveItemPayload }
  | { type: 'CHANGE_QUANTITY'; payload: ChangeQuantityPayload }
  | { type: 'SEND_TO_KITCHEN'; payload: SendToKitchenPayload }
  | { type: 'START_PREPARING'; payload: StartPreparingPayload }
  | { type: 'MARK_READY'; payload: MarkReadyPayload }
  | { type: 'PAY'; payload: PayPayload }
  | { type: 'CANCEL'; payload: CancelPayload };

export type Decision =
  /** The mutation may proceed; the versioned UPDATE is still the guard that decides the race. */
  | { kind: 'apply'; nextStatus: OrderStatus }
  /** Already reflected in server state and semantically safe to treat as a repeat (§8). */
  | { kind: 'already-applied' }
  | { kind: 'conflict'; reason: ConflictReason };

/**
 * The single place that answers "may this mutation apply to the order as it currently stands?"
 * The whole of §8 lives here and nowhere else — no controller, no store and no SQL statement
 * carries a rule of its own.
 *
 * It deliberately knows nothing about versions: staleness is caught by the SQL guard in §6, and
 * mixing the two here would hide which check actually rejected a mutation. A domain conflict is
 * returned even when the version also matches, because "the kitchen is already cooking" is a
 * better answer than "your version is old". §21.4 is exactly that case — a client at v5 against a
 * cancelled order at v6 must hear `ORDER_CANCELLED`, the reason it can act on.
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

  // CANCEL is answered before the terminal-status guard on purpose: §8's `CANCELLED` reject list
  // names seven mutation types and CANCEL is not among them. Cancelling a cancelled order is the
  // clearest case of "already reflected in server state, and safe" — the intent is satisfied.
  if (command.type === 'CANCEL') {
    if (order.status === 'CANCELLED') {
      return { kind: 'already-applied' };
    }
    if (order.status === 'PAID') {
      return { kind: 'conflict', reason: 'ORDER_ALREADY_PAID' };
    }
    return { kind: 'apply', nextStatus: 'CANCELLED' };
  }

  const blocked = blockingStatusConflict(order.status);
  if (blocked !== undefined) {
    return { kind: 'conflict', reason: blocked };
  }

  switch (command.type) {
    case 'ADD_ITEM':
    case 'REMOVE_ITEM':
    case 'CHANGE_QUANTITY':
      return decideItemChange(order, command);

    case 'SEND_TO_KITCHEN':
      // Reached only from a non-terminal status, so anything but OPEN means the kitchen already
      // has it. That reads better than INVALID_STATUS_TRANSITION and it is what the POS shows.
      return order.status === 'OPEN'
        ? { kind: 'apply', nextStatus: 'SENT_TO_KITCHEN' }
        : { kind: 'conflict', reason: 'ORDER_ALREADY_SENT_TO_KITCHEN' };

    case 'START_PREPARING':
      return decideTransition(order.status, 'PREPARING');

    case 'MARK_READY':
      return decideTransition(order.status, 'READY');

    case 'PAY':
      return decideTransition(order.status, 'PAID');
  }
}

/**
 * Item mutations are refused once the kitchen has the order (§8). This is the rule the offline
 * conflict demo rests on, so it is a hard reject rather than a merge.
 */
function decideItemChange(
  order: OrderSnapshot,
  command: Extract<MutationCommand, { type: 'ADD_ITEM' | 'REMOVE_ITEM' | 'CHANGE_QUANTITY' }>,
): Decision {
  if (order.status !== 'OPEN') {
    return { kind: 'conflict', reason: 'ORDER_ALREADY_SENT_TO_KITCHEN' };
  }

  if (command.type === 'ADD_ITEM') {
    return { kind: 'apply', nextStatus: order.status };
  }

  const held = order.items.find((item) => item.productId === command.payload.productId);

  if (command.type === 'REMOVE_ITEM') {
    // The one §8 "idempotent where semantically safe" case among the item mutations. Two
    // terminals removing the same line both wanted it gone, and it is gone; answering CONFLICT
    // would halt an offline queue (§14.1) over an operation whose intent is already satisfied.
    return held === undefined
      ? { kind: 'already-applied' }
      : { kind: 'apply', nextStatus: order.status };
  }

  // A quantity change naming a line the order does not have is a conflict, not a bad request:
  // another terminal may have removed it a second ago, which is canonical state disagreeing with
  // the client. A change to the quantity already stored still applies and still bumps the
  // version — §8 says concurrent quantity changes conflict and the server is canonical, and it
  // carves out no exception for two clients that happen to agree. The version guard decides that
  // race; a value comparison here would be a second mechanism answering the same question.
  return held === undefined
    ? { kind: 'conflict', reason: 'ITEM_NOT_IN_ORDER' }
    : { kind: 'apply', nextStatus: order.status };
}

/**
 * §8: kitchen transitions follow the status order, and an out-of-order transition conflicts —
 * including a repeat, because pressing Ready on an order that is already READY is out of order.
 * A genuine retry of the *same* mutation never reaches this; §9 answers it from
 * `processed_mutations` first.
 */
function decideTransition(from: OrderStatus, to: OrderStatus): Decision {
  return isValidTransition(from, to)
    ? { kind: 'apply', nextStatus: to }
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
