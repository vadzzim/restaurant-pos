import type {
  AddItemPayload,
  ConflictReason,
  CreateOrderPayload,
  MutationRequest,
  MutationResponse,
  OrderSnapshot,
  SupportedMutationType,
} from '@pos/contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { fetchOrder, postMutation } from '../api/client';

export interface ConflictBanner {
  reason: ConflictReason;
  clientBaseVersion: number;
  serverVersion: number;
}

/**
 * Everything that makes a mutation *the same* mutation on a retry. `orderId` belongs here as much
 * as `mutationId` does: for `CREATE_ORDER` it is the aggregate's identity, and generating a fresh
 * one is what turns a retry into a second order.
 */
export interface MutationIdentity {
  orderId: string;
  mutationId: string;
  type: SupportedMutationType;
  baseVersion: number;
  payload: MutationRequest['payload'];
}

/**
 * A snapshot may only move forward. Socket events fire refetches without waiting for each other,
 * so two `GET /api/orders/:id` calls can be in flight at once and the older response can land
 * last; adopting it unconditionally would roll the screen back to a state the server has already
 * left. The version is monotonic per order, which makes this check exact rather than heuristic.
 */
export function acceptsSnapshot(held: OrderSnapshot | undefined, incoming: OrderSnapshot): boolean {
  if (held === undefined || held.id !== incoming.id) {
    return true;
  }

  return incoming.version >= held.version;
}

/**
 * Whether a pending identity describes the action being attempted now. The payloads are built here
 * in a fixed key order, so comparing their serialisations is sound.
 */
export function sameMutation(
  pending: MutationIdentity | undefined,
  type: SupportedMutationType,
  orderId: string | undefined,
  baseVersion: number,
  payload: MutationRequest['payload'],
): boolean {
  if (pending === undefined || pending.type !== type || pending.baseVersion !== baseVersion) {
    return false;
  }

  if (orderId !== undefined && pending.orderId !== orderId) {
    return false;
  }

  return JSON.stringify(pending.payload) === JSON.stringify(payload);
}

export const useOrderStore = defineStore('order', () => {
  const order = ref<OrderSnapshot | undefined>();
  const conflict = ref<ConflictBanner | undefined>();
  const lastError = ref<string | undefined>();
  const inFlight = ref(0);
  /**
   * The one mutation whose fate is unknown: it left this client but no answer came back. It is
   * kept so the operator's next attempt reuses the same `mutationId` and `orderId` and is resolved
   * idempotently by §9, instead of being sent as a brand-new mutation. M8 replaces this one slot
   * with the durable queue; the reasoning is the same, the storage is not.
   */
  const pending = ref<MutationIdentity | undefined>();

  const version = computed(() => order.value?.version ?? 0);
  const syncing = computed(() => inFlight.value > 0);

  function adopt(snapshot: OrderSnapshot): void {
    if (acceptsSnapshot(order.value, snapshot)) {
      order.value = snapshot;
    }
  }

  /**
   * The canonical read (§13). Every socket message that survives the gate ends here rather than
   * being applied as a payload: the server owns the arithmetic, the browser only displays it.
   */
  async function refetch(): Promise<void> {
    const id = order.value?.id;
    if (id === undefined) {
      return;
    }

    const snapshot = await fetchOrder(id);
    if (snapshot !== undefined) {
      adopt(snapshot);
    }
  }

  async function send(
    identity: MutationIdentity,
    terminalId: string,
    restaurantId: string,
  ): Promise<MutationResponse | undefined> {
    const request: MutationRequest = {
      mutationId: identity.mutationId,
      terminalId,
      restaurantId,
      baseVersion: identity.baseVersion,
      type: identity.type,
      payload: identity.payload,
    };

    inFlight.value += 1;
    pending.value = identity;
    try {
      const response = await postMutation(identity.orderId, request);

      // The server answered, so this mutation's fate is known however it turned out. Only a
      // request that never produced an answer stays pending.
      pending.value = undefined;

      switch (response.status) {
        case 'APPLIED':
        case 'ALREADY_APPLIED':
          conflict.value = undefined;
          lastError.value = undefined;
          adopt(response.order);
          break;
        case 'CONFLICT':
          // The server's version of the truth replaces ours immediately; resolving the *queue* is
          // M8's problem, and this milestone has no queue to halt.
          conflict.value = {
            reason: response.reason,
            clientBaseVersion: response.clientBaseVersion,
            serverVersion: response.serverVersion,
          };
          adopt(response.canonicalOrder);
          break;
        default:
          lastError.value = response.reason;
      }

      return response;
    } catch (error) {
      // `pending` deliberately survives: the mutation may well have been applied.
      lastError.value = error instanceof Error ? error.message : 'The mutation failed.';
      return undefined;
    } finally {
      inFlight.value -= 1;
    }
  }

  async function createOrder(
    terminalId: string,
    restaurantId: string,
    tableNumber: string,
  ): Promise<void> {
    const payload: CreateOrderPayload = { tableNumber };
    const retrying = sameMutation(pending.value, 'CREATE_ORDER', undefined, 0, payload);

    // Reusing the id is the whole point (§5). A lost response plus a fresh `orderId` would create
    // a second order for the same table — the one write in the system that no version check and
    // no `mutationId` could catch afterwards.
    const identity: MutationIdentity = retrying
      ? (pending.value as MutationIdentity)
      : {
          orderId: crypto.randomUUID(),
          mutationId: crypto.randomUUID(),
          type: 'CREATE_ORDER',
          baseVersion: 0,
          payload,
        };

    if (!retrying) {
      order.value = undefined;
      conflict.value = undefined;
    }

    await send(identity, terminalId, restaurantId);
  }

  async function addItem(
    terminalId: string,
    restaurantId: string,
    productId: string,
    quantity = 1,
  ): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    const payload: AddItemPayload = { productId, quantity };
    await send(
      identityFor('ADD_ITEM', current.id, current.version, payload),
      terminalId,
      restaurantId,
    );
  }

  async function sendToKitchen(terminalId: string, restaurantId: string): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    await send(
      identityFor('SEND_TO_KITCHEN', current.id, current.version, {}),
      terminalId,
      restaurantId,
    );
  }

  /**
   * Retrying with the same `mutationId` turns a lost response into `ALREADY_APPLIED` (§9). With a
   * fresh one the retry is a new mutation at a stale `baseVersion`, so it comes back as a conflict
   * over an operation that in fact succeeded — technically safe, and a lie to the operator.
   */
  function identityFor(
    type: SupportedMutationType,
    orderId: string,
    baseVersion: number,
    payload: MutationRequest['payload'],
  ): MutationIdentity {
    if (sameMutation(pending.value, type, orderId, baseVersion, payload)) {
      return pending.value as MutationIdentity;
    }

    return { orderId, mutationId: crypto.randomUUID(), type, baseVersion, payload };
  }

  /** Re-send the mutation whose answer never arrived, unchanged. */
  async function retryPending(terminalId: string, restaurantId: string): Promise<void> {
    const identity = pending.value;
    if (identity !== undefined) {
      await send(identity, terminalId, restaurantId);
    }
  }

  function clear(): void {
    order.value = undefined;
    conflict.value = undefined;
    lastError.value = undefined;
    pending.value = undefined;
  }

  return {
    order,
    conflict,
    lastError,
    pending,
    version,
    syncing,
    adopt,
    refetch,
    createOrder,
    addItem,
    sendToKitchen,
    retryPending,
    clear,
  };
});
