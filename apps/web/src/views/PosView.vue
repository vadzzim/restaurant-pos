<script setup lang="ts">
import type { PaymentMethod } from '@pos/contracts';
import { findTerminal } from '@pos/contracts';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import StateBadge from '../components/StateBadge.vue';
import { useConnectionStore } from '../stores/connection';
import { useMenuStore } from '../stores/menu';
import { useOrderStore } from '../stores/order';

const route = useRoute();
const menu = useMenuStore();
const orders = useOrderStore();
const connection = useConnectionStore();

const terminalId = computed(() => String(route.params.terminalId));
const terminal = computed(() => findTerminal(terminalId.value));
const tableNumber = ref('12');
const busy = ref(false);

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const status = computed(() => orders.order?.status);

/** Items may only change while the order is OPEN — after that the kitchen is cooking it (§8). */
const canOrder = computed(() => status.value === 'OPEN' && !orders.blocked);
/** `ALLOWED_TRANSITIONS` permits PAID from OPEN and from READY, and from nowhere else. */
const canPay = computed(
  () => (status.value === 'OPEN' || status.value === 'READY') && !orders.blocked,
);
const canCancel = computed(
  () =>
    status.value !== undefined &&
    status.value !== 'PAID' &&
    status.value !== 'CANCELLED' &&
    !orders.blocked,
);

async function start(): Promise<void> {
  const restaurantId = terminal.value?.restaurantId;
  if (restaurantId === undefined) {
    return;
  }

  // The store is a singleton and the terminal is a route parameter, so it has to be told which
  // terminal's screen this is: only that terminal's unresolved mutation may be shown or retried.
  orders.useTerminal(terminalId.value);

  await menu.load();
  await connection.start({
    restaurantId,
    role: 'pos',
    currentOrderId: () => orders.order?.id,
    // Anything about another order is news by definition, so the version we hold for it is 0.
    heldVersion: (aggregateId) =>
      orders.order?.id === aggregateId ? (orders.order?.version ?? 0) : 0,
    // The POS reads `orders`, written by the very transaction that wrote the outbox row, so the
    // event it was woken by is already visible: one read is always enough here.
    refresh: () => orders.refetch(),
  });
}

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  try {
    await action();
  } finally {
    busy.value = false;
  }
}

const retryPending = (): Promise<void> => run(() => orders.retryPending());

const createOrder = (): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId === undefined) {
      return;
    }
    await orders.createOrder(terminalId.value, restaurantId, tableNumber.value);
    // The socket has to start following the new aggregate's room (§13).
    connection.resubscribe();
  });

const addItem = (productId: string): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.addItem(terminalId.value, restaurantId, productId);
    }
  });

const removeItem = (productId: string): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.removeItem(terminalId.value, restaurantId, productId);
    }
  });

const changeQuantity = (productId: string, quantity: number): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.changeQuantity(terminalId.value, restaurantId, productId, quantity);
    }
  });

const sendToKitchen = (): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.sendToKitchen(terminalId.value, restaurantId);
    }
  });

const pay = (method: PaymentMethod): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.pay(terminalId.value, restaurantId, method);
    }
  });

const cancel = (): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.cancel(terminalId.value, restaurantId, 'Cancelled at the till');
    }
  });

onMounted(start);
onBeforeUnmount(() => {
  connection.stop();
  orders.clear();
});

// Switching terminals in the URL is switching restaurants: rebuild the whole connection.
watch(terminalId, async () => {
  connection.stop();
  orders.clear();
  await start();
});
</script>

<template>
  <section v-if="terminal === undefined">
    <h1 class="text-2xl font-semibold">Unknown terminal “{{ terminalId }}”</h1>
    <p class="mt-2 text-stone-600">Try /pos/pos-1, /pos/pos-2, /pos/bar-1 or /pos/pos-3.</p>
  </section>

  <section v-else class="space-y-6">
    <header class="flex flex-wrap items-center gap-3">
      <h1 class="mr-2 text-2xl font-semibold">{{ terminal.label }}</h1>
      <StateBadge :label="terminal.restaurantId" />
      <StateBadge
        :label="connection.online ? 'ONLINE' : 'OFFLINE'"
        :tone="connection.online ? 'ok' : 'bad'"
      />
      <StateBadge
        :label="`WS ${connection.socketState}`"
        :tone="connection.socketState === 'CONNECTED' ? 'ok' : 'warn'"
      />
      <StateBadge :label="connection.transport" :tone="connection.pushEnabled ? 'ok' : 'warn'" />
      <StateBadge
        v-if="orders.order"
        :label="`v${orders.version}`"
        :tone="orders.syncing ? 'warn' : 'ok'"
      />
      <StateBadge v-if="orders.syncing" label="SYNCING" tone="warn" />
      <StateBadge v-if="orders.pending" label="PENDING" tone="warn" />
      <StateBadge v-if="orders.readError" label="READ FAILED" tone="bad" />
    </header>

    <p
      v-if="orders.pending"
      class="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <span>
        <strong>{{ orders.pending.type }} left this terminal but no answer came back.</strong>
        This terminal takes no new commands until it is resolved — there is one slot, and sending
        anything else would overwrite the only <code>mutationId</code> that can still settle it.
        Retrying reuses that id, so if the server did apply it the answer is
        <code>ALREADY_APPLIED</code> rather than a second one. Discarding accepts that the outcome
        will stay unknown.
      </span>
      <span class="flex gap-2">
        <button
          type="button"
          class="rounded border border-amber-500 px-3 py-1 font-medium disabled:opacity-40"
          :disabled="busy"
          @click="retryPending"
        >
          Retry
        </button>
        <button
          type="button"
          class="rounded border border-amber-400 px-3 py-1 disabled:opacity-40"
          :disabled="busy"
          @click="orders.discardPending()"
        >
          Discard
        </button>
      </span>
    </p>

    <p
      v-if="orders.conflict"
      class="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <strong>CONFLICT — {{ orders.conflict.reason }}.</strong>
      Sent at v{{ orders.conflict.clientBaseVersion }}, the server is at v{{
        orders.conflict.serverVersion
      }}. The canonical order is shown below.
    </p>

    <p
      v-if="orders.readError"
      class="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      The order could not be re-read: {{ orders.readError }}. What is shown is the last good read;
      the next event or a reconnect retries.
    </p>

    <p
      v-if="orders.lastError"
      class="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      {{ orders.lastError }}
    </p>

    <div class="grid gap-6 md:grid-cols-2">
      <div class="rounded border border-stone-300 bg-white p-4">
        <h2 class="mb-3 text-lg font-semibold">Menu</h2>
        <ul class="grid grid-cols-2 gap-2">
          <li v-for="item in menu.items" :key="item.id">
            <button
              type="button"
              class="w-full rounded border border-stone-300 px-3 py-3 text-left hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!canOrder || busy"
              @click="addItem(item.id)"
            >
              <span class="block font-medium">{{ item.name }}</span>
              <span class="text-sm text-stone-600">{{ money(item.priceCents) }}</span>
            </button>
          </li>
        </ul>
      </div>

      <div class="rounded border border-stone-300 bg-white p-4">
        <h2 class="mb-3 text-lg font-semibold">Current order</h2>

        <form v-if="!orders.order" class="flex items-end gap-3" @submit.prevent="createOrder">
          <label class="text-sm">
            <span class="mb-1 block text-stone-600">Table</span>
            <input
              v-model="tableNumber"
              class="w-24 rounded border border-stone-300 px-3 py-2"
              required
            />
          </label>
          <button
            type="submit"
            class="rounded bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-40"
            :disabled="busy || orders.blocked"
          >
            Create order
          </button>
        </form>

        <div v-else class="space-y-3">
          <p class="text-sm text-stone-600">
            Table {{ orders.order.tableNumber }} · {{ orders.order.status }} ·
            <code class="text-xs">{{ orders.order.id }}</code>
          </p>

          <ul v-if="orders.order.items.length" class="divide-y divide-stone-200">
            <li
              v-for="item in orders.order.items"
              :key="item.productId"
              class="flex items-center justify-between gap-3 py-2"
            >
              <span class="flex-1">{{ item.name }}</span>
              <span class="flex items-center gap-1">
                <button
                  type="button"
                  class="h-8 w-8 rounded border border-stone-300 leading-none disabled:opacity-30"
                  :disabled="!canOrder || busy"
                  :aria-label="`One fewer ${item.name}`"
                  @click="changeQuantity(item.productId, item.quantity - 1)"
                >
                  −
                </button>
                <span class="w-8 text-center tabular-nums">{{ item.quantity }}</span>
                <button
                  type="button"
                  class="h-8 w-8 rounded border border-stone-300 leading-none disabled:opacity-30"
                  :disabled="!canOrder || busy"
                  :aria-label="`One more ${item.name}`"
                  @click="changeQuantity(item.productId, item.quantity + 1)"
                >
                  +
                </button>
              </span>
              <span class="w-20 text-right">{{ money(item.quantity * item.unitPriceCents) }}</span>
              <button
                type="button"
                class="rounded border border-stone-300 px-2 py-1 text-sm disabled:opacity-30"
                :disabled="!canOrder || busy"
                @click="removeItem(item.productId)"
              >
                Remove
              </button>
            </li>
          </ul>
          <p v-else class="text-sm text-stone-500">No items yet.</p>

          <p class="flex justify-between border-t border-stone-300 pt-3 text-lg font-semibold">
            <span>Total</span>
            <span>{{ money(orders.order.totalCents) }}</span>
          </p>

          <div class="flex flex-wrap gap-3">
            <button
              type="button"
              class="rounded bg-[#17201c] px-4 py-2 font-medium text-white disabled:opacity-40"
              :disabled="!canOrder || busy || orders.order.items.length === 0"
              @click="sendToKitchen"
            >
              Send to kitchen
            </button>
            <button
              type="button"
              class="rounded bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-40"
              :disabled="!canPay || busy"
              @click="pay('CARD')"
            >
              Pay card
            </button>
            <button
              type="button"
              class="rounded bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-40"
              :disabled="!canPay || busy"
              @click="pay('CASH')"
            >
              Pay cash
            </button>
            <button
              type="button"
              class="rounded border border-rose-400 px-4 py-2 text-rose-800 disabled:opacity-40"
              :disabled="!canCancel || busy"
              @click="cancel"
            >
              Cancel order
            </button>
            <button
              type="button"
              class="rounded border border-stone-300 px-4 py-2 disabled:opacity-40"
              :disabled="busy || orders.blocked"
              @click="orders.clear()"
            >
              New order
            </button>
          </div>

          <p class="text-xs text-stone-500">
            Payment is allowed from <code>OPEN</code> and from <code>READY</code>, never while the
            kitchen is cooking; items are frozen once the order is sent. Every button above is a
            mutation with its own <code>mutationId</code> and the version shown in the header.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
