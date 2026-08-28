<script setup lang="ts">
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

const canOrder = computed(() => orders.order?.status === 'OPEN');

async function start(): Promise<void> {
  const restaurantId = terminal.value?.restaurantId;
  if (restaurantId === undefined) {
    return;
  }

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

const retryPending = (): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.retryPending(terminalId.value, restaurantId);
    }
  });

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

const sendToKitchen = (): Promise<void> =>
  run(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.sendToKitchen(terminalId.value, restaurantId);
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
    </header>

    <p
      v-if="orders.pending"
      class="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <span>
        <strong>{{ orders.pending.type }} left this terminal but no answer came back.</strong>
        Retrying reuses the same <code>mutationId</code>, so if the server did apply it the answer
        is <code>ALREADY_APPLIED</code> rather than a second one.
      </span>
      <button
        type="button"
        class="rounded border border-amber-500 px-3 py-1 font-medium"
        :disabled="busy"
        @click="retryPending"
      >
        Retry
      </button>
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
            :disabled="busy"
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
              class="flex justify-between py-2"
            >
              <span>{{ item.quantity }} × {{ item.name }}</span>
              <span>{{ money(item.quantity * item.unitPriceCents) }}</span>
            </li>
          </ul>
          <p v-else class="text-sm text-stone-500">No items yet.</p>

          <p class="flex justify-between border-t border-stone-300 pt-3 text-lg font-semibold">
            <span>Total</span>
            <span>{{ money(orders.order.totalCents) }}</span>
          </p>

          <div class="flex gap-3">
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
              class="rounded border border-stone-300 px-4 py-2"
              :disabled="busy"
              @click="orders.clear()"
            >
              New order
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
