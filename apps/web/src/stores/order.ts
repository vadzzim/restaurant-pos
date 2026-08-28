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

export const useOrderStore = defineStore('order', () => {
  const order = ref<OrderSnapshot | undefined>();
  const conflict = ref<ConflictBanner | undefined>();
  const lastError = ref<string | undefined>();
  const inFlight = ref(0);

  const version = computed(() => order.value?.version ?? 0);
  const syncing = computed(() => inFlight.value > 0);

  function adopt(snapshot: OrderSnapshot): void {
    order.value = snapshot;
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
    orderId: string,
    terminalId: string,
    restaurantId: string,
    type: SupportedMutationType,
    baseVersion: number,
    payload: MutationRequest['payload'],
  ): Promise<MutationResponse> {
    const request: MutationRequest = {
      mutationId: crypto.randomUUID(),
      terminalId,
      restaurantId,
      baseVersion,
      type,
      payload,
    };

    inFlight.value += 1;
    try {
      const response = await postMutation(orderId, request);

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
      lastError.value = error instanceof Error ? error.message : 'The mutation failed.';
      throw error;
    } finally {
      inFlight.value -= 1;
    }
  }

  async function createOrder(
    terminalId: string,
    restaurantId: string,
    tableNumber: string,
  ): Promise<string> {
    // The client generates the id (§5): there is no POST /api/orders, so creation is a mutation
    // like any other and a lost response can be retried without creating a second order.
    const orderId = crypto.randomUUID();
    order.value = undefined;
    conflict.value = undefined;

    const payload: CreateOrderPayload = { tableNumber };
    const response = await send(orderId, terminalId, restaurantId, 'CREATE_ORDER', 0, payload);

    if (response.status !== 'APPLIED' && response.status !== 'ALREADY_APPLIED') {
      throw new Error(`CREATE_ORDER did not apply: ${response.status}`);
    }

    return orderId;
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
    await send(current.id, terminalId, restaurantId, 'ADD_ITEM', current.version, payload);
  }

  async function sendToKitchen(terminalId: string, restaurantId: string): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    await send(current.id, terminalId, restaurantId, 'SEND_TO_KITCHEN', current.version, {});
  }

  function clear(): void {
    order.value = undefined;
    conflict.value = undefined;
    lastError.value = undefined;
  }

  return {
    order,
    conflict,
    lastError,
    version,
    syncing,
    adopt,
    refetch,
    createOrder,
    addItem,
    sendToKitchen,
    clear,
  };
});
