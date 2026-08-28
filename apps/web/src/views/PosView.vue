<script setup lang="ts">
import type { PaymentMethod } from '@pos/contracts';
import { findTerminal } from '@pos/contracts';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import StateBadge from '../components/StateBadge.vue';
import { isTerminalOffline, toggleTerminalOffline } from '../api/offline';
import { persistenceError } from '../persistence/local-store';
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

/**
 * The screen renders the **projection** — the canonical snapshot with the queue folded onto it —
 * because §14 says the UI updates optimistically and never waits for the server. `orders.order` is
 * still the canonical truth and is what the conflict panel shows beside the local intent.
 */
const shown = computed(() => orders.projected);
const status = computed(() => shown.value?.status);

/** Items may only change while the order is OPEN — after that the kitchen is cooking it (§8). */
const canOrder = computed(() => status.value === 'OPEN' && !orders.halted);
/** `ALLOWED_TRANSITIONS` permits PAID from OPEN and from READY, and from nowhere else. */
const canPay = computed(
  () => (status.value === 'OPEN' || status.value === 'READY') && !orders.halted,
);
const canCancel = computed(
  () =>
    status.value !== undefined &&
    status.value !== 'PAID' &&
    status.value !== 'CANCELLED' &&
    !orders.halted,
);

/** §18's `Simulate POS-n Offline`, intercepting in the API client so the stores stay single-path. */
const offline = computed(() => isTerminalOffline(terminalId.value));

async function toggleOffline(): Promise<void> {
  const nowOffline = toggleTerminalOffline(terminalId.value);
  // Coming back is a sync trigger; going away is not. There are no timers anywhere in the engine.
  if (!nowOffline) {
    await run(() => orders.sync());
  }
}

async function start(): Promise<void> {
  const restaurantId = terminal.value?.restaurantId;
  if (restaurantId === undefined) {
    return;
  }

  // The store is a singleton and the terminal is a route parameter, so it has to be told which
  // terminal's screen this is: only that terminal's unresolved mutation may be shown or retried.
  orders.useTerminal(terminalId.value);

  // Restores the cached order and any unresolved mutation, and ends with a canonical read — the
  // cache is never authoritative, and the socket's own refresh does not run on every transport.
  await orders.hydrate(terminalId.value);

  await menu.load();
  await connection.start({
    restaurantId,
    role: 'pos',
    // The order this screen is on, which may be one that exists only in this client's queue —
    // an order created offline still has a room to join the moment the socket comes up.
    currentOrderId: () => orders.currentOrderId,
    // The **canonical** version, not the projected one: the gate is deciding whether a server
    // event carries news, and the projection is this client's guess about the future.
    heldVersion: (aggregateId) => (orders.order?.id === aggregateId ? orders.canonicalVersion : 0),
    // The POS reads `orders`, written by the very transaction that wrote the outbox row, so the
    // event it was woken by is already visible: one read is always enough here.
    //
    // A reconnect drains the queue first and reads second (§14): the mutations this client is
    // holding are what the snapshot ought to include, and reading before sending would paint a
    // server state the operator has already moved past.
    refresh: async () => {
      await orders.sync();
      await orders.refetch();
    },
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

const syncNow = (): Promise<void> => run(() => orders.sync());
const discardHalted = (): Promise<void> => run(() => orders.discardHalted());
const rebaseHalted = (): Promise<void> => run(() => orders.rebaseHalted());

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

// The browser coming back is the other sync trigger. `Simulate Offline` has its own above.
watch(
  () => connection.online,
  (online) => {
    if (online) {
      void orders.sync();
    }
  },
);

onMounted(start);
onBeforeUnmount(() => {
  connection.stop();
  void orders.clear();
  // `clear()` empties the screen; this gives up the claim on it. Without it a hydration still
  // reading from disk would find `activeTerminalId` unchanged, pass its owner check and restore
  // the order onto a screen that no longer exists.
  orders.releaseTerminal();
});

// Switching terminals in the URL is switching restaurants: rebuild the whole connection.
watch(terminalId, async () => {
  connection.stop();
  void orders.clear();
  // `start()` claims the new terminal, but it returns early for an unknown one — so the claim on
  // the old terminal is dropped here rather than left to be overwritten.
  orders.releaseTerminal();
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
        v-if="shown"
        :label="`v${orders.version}`"
        :tone="orders.syncing ? 'warn' : 'ok'"
      />
      <StateBadge v-if="offline" label="SIMULATED OFFLINE" tone="bad" />
      <StateBadge v-if="orders.syncing" label="SYNCING" tone="warn" />
      <StateBadge
        v-if="orders.pendingCount"
        :label="`${orders.pendingCount} PENDING`"
        tone="warn"
      />
      <StateBadge v-if="orders.halted" label="QUEUE HALTED" tone="bad" />
      <StateBadge v-if="orders.readError" label="READ FAILED" tone="bad" />
      <StateBadge v-if="persistenceError" label="NOT DURABLE" tone="bad" />

      <button
        type="button"
        class="ml-auto rounded border px-3 py-1 text-sm font-medium"
        :class="
          offline
            ? 'border-rose-500 bg-rose-100 text-rose-900'
            : 'border-stone-300 text-stone-700 hover:bg-stone-100'
        "
        @click="toggleOffline"
      >
        {{ offline ? 'Go back online' : 'Simulate Offline' }}
      </button>
    </header>

    <p
      v-if="offline"
      class="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <strong>{{ terminalId }} is pretending the API is unreachable.</strong>
      The interception is in the API client, not in the stores and not in the browser's own offline
      mode, so the demo is deterministic and every screen keeps one code path. Reads are cut off as
      well as writes — otherwise this terminal would quietly learn what another one did to the order
      and the queued versions would stop being stale. Commands keep working and pile up locally.
    </p>

    <p
      v-if="persistenceError"
      class="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <strong>This device is not storing anything locally.</strong>
      {{ persistenceError }}. Commands still reach the server, but a reload will lose the order on
      screen and — worse — the identity of any mutation that has no answer yet.
    </p>

    <div
      v-if="orders.halted"
      class="space-y-3 rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <p>
        <strong>The queue for this order is halted (§14.1).</strong>
        <span v-if="orders.currentConflict">
          <code>{{ orders.conflictedMutation?.type }}</code> was sent at v{{
            orders.currentConflict.clientBaseVersion
          }}
          and the server answered <code>{{ orders.currentConflict.reason }}</code> at v{{
            orders.currentConflict.serverVersion
          }}.
        </span>
        Everything queued behind it is <code>BLOCKED</code> and has <strong>not</strong> been sent —
        their <code>baseVersion</code> is provably stale, and sending them would produce a cascade
        of conflicts that looks like a broken client. Mutations for other orders keep syncing.
        Nothing resolves itself.
      </p>

      <div class="grid gap-3 md:grid-cols-2">
        <div class="rounded border border-rose-200 bg-white p-3">
          <h3 class="mb-1 font-semibold">The server's canonical order</h3>
          <p v-if="orders.order" class="text-stone-700">
            v{{ orders.canonicalVersion }} · {{ orders.order.status }} ·
            {{ money(orders.order.totalCents) }} · {{ orders.order.items.length }} line(s)
          </p>
          <p v-else class="text-stone-700">The server has no order at this id.</p>
        </div>
        <div class="rounded border border-rose-200 bg-white p-3">
          <h3 class="mb-1 font-semibold">This terminal's queued intent</h3>
          <ol class="list-decimal space-y-1 pl-5 text-stone-700">
            <li v-for="row in orders.currentQueue" :key="row.mutationId">
              <code>{{ row.type }}</code> at v{{ row.baseVersion }} —
              <strong>{{ row.status }}</strong>
              <code class="ml-1 text-xs text-stone-500">{{ row.mutationId.slice(0, 8) }}</code>
            </li>
          </ol>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded border border-rose-500 px-3 py-1 font-medium disabled:opacity-40"
          :disabled="busy"
          @click="discardHalted"
        >
          Discard {{ orders.currentQueue.length }} mutation(s)
        </button>
        <button
          type="button"
          class="rounded border border-rose-400 px-3 py-1 disabled:opacity-40"
          :disabled="busy"
          @click="rebaseHalted"
        >
          Rebase onto v{{ orders.canonicalVersion }}
        </button>
      </div>

      <p class="text-xs">
        A rebase re-issues them one at a time, each with a <strong>new</strong>
        <code>mutationId</code> at the version the previous one produced — never a batch re-stamp,
        because each successful mutation advances the version. Any of them may conflict again: a
        rebase onto a cancelled order fails on the first attempt and the rest stay blocked.
      </p>
    </div>

    <p
      v-else-if="orders.pendingCount"
      class="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <span>
        <strong>{{ orders.pendingCount }} mutation(s) queued locally.</strong>
        <span v-if="orders.pendingForOtherOrders">
          {{ orders.pendingForOtherOrders }} of them belong to an order this screen has left — the
          queue is per aggregate and they sync on their own.
        </span>
        Each keeps its <code>mutationId</code> across a reload, so a re-send is answered
        <code>ALREADY_APPLIED</code> rather than applied twice.
      </span>
      <button
        type="button"
        class="rounded border border-amber-500 px-3 py-1 font-medium disabled:opacity-40"
        :disabled="busy || offline"
        @click="syncNow"
      >
        Sync now
      </button>
    </p>

    <p
      v-if="orders.currentConflict && !orders.halted"
      class="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <strong>CONFLICT — {{ orders.currentConflict.reason }}.</strong>
      Sent at v{{ orders.currentConflict.clientBaseVersion }}, the server is at v{{
        orders.currentConflict.serverVersion
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

    <p
      v-for="strandedId in orders.haltedElsewhere"
      :key="strandedId"
      class="flex flex-wrap items-center gap-3 rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <span>
        <strong>Another order queued on this terminal is halted.</strong>
        The halt is per aggregate and this screen is on a different one, so nothing here can resolve
        it — and until it is resolved those mutations are neither sent nor discarded.
        <code class="text-xs">{{ strandedId }}</code>
      </span>
      <button
        type="button"
        class="rounded border border-rose-500 px-3 py-1 font-medium disabled:opacity-40"
        :disabled="busy"
        @click="run(() => orders.focusOrder(strandedId))"
      >
        Go to it
      </button>
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

        <form v-if="!shown" class="flex items-end gap-3" @submit.prevent="createOrder">
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
            :disabled="busy || orders.halted"
          >
            Create order
          </button>
        </form>

        <div v-else class="space-y-3">
          <p class="text-sm text-stone-600">
            Table {{ shown.tableNumber }} · {{ shown.status }} ·
            <code class="text-xs">{{ shown.id }}</code>
          </p>

          <ul v-if="shown.items.length" class="divide-y divide-stone-200">
            <li
              v-for="item in shown.items"
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
            <span>{{ money(shown.totalCents) }}</span>
          </p>

          <div class="flex flex-wrap gap-3">
            <button
              type="button"
              class="rounded bg-[#17201c] px-4 py-2 font-medium text-white disabled:opacity-40"
              :disabled="!canOrder || busy || shown.items.length === 0"
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
              :disabled="busy || orders.halted"
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
