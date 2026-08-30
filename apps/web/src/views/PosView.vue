<script setup lang="ts">
import type { PaymentMethod } from '@pos/contracts';
import { TERMINALS, findTerminal } from '@pos/contracts';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import StateBadge from '../components/StateBadge.vue';
import { isTerminalOffline, toggleTerminalOffline } from '../api/offline';
import {
  affordances,
  conflictHeadline,
  coverNoun,
  coversFor,
  menuTiles,
} from '../domain/pos-screen';
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
const profile = computed(() => terminal.value?.profile ?? 'dining');

/**
 * The *commit* flag, and the only thing on this screen that disables anything.
 *
 * It covers create, send, pay, cancel, discard and rebase — one-tap-then-look-up actions where a
 * double fire is worse than a wait. It deliberately does **not** cover the item path: see `tap`.
 */
const committing = ref(false);
const showEvidence = ref(false);
const cover = ref('');

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/**
 * The screen renders the **projection** — the canonical snapshot with the queue folded onto it —
 * because §14 says the UI updates optimistically and never waits for the server. `orders.order` is
 * still the canonical truth and is what the conflict evidence shows beside the local intent.
 */
const shown = computed(() => orders.projected);

/** §16's affordances, and the conflict headline, as pure functions of that projection. */
const can = computed(() => affordances(shown.value, orders.halted));
const headline = computed(() => conflictHeadline(orders.currentConflict, orders.currentQueue));
const tiles = computed(() => menuTiles(menu.items, profile.value, shown.value));
const covers = computed(() => coversFor(profile.value));
const noun = computed(() => coverNoun(profile.value));

/** The bar has to be unmistakable beside a POS in a second window — §19 is demoed side by side. */
const isBar = computed(() => profile.value === 'bar');

/** §18's `Simulate POS-n Offline`, intercepting in the API client so the stores stay single-path. */
const offline = computed(() => isTerminalOffline(terminalId.value));

async function toggleOffline(): Promise<void> {
  const nowOffline = toggleTerminalOffline(terminalId.value);
  // Coming back is a sync trigger; going away is not. There are no timers anywhere in the engine.
  if (!nowOffline) {
    await commit(() => orders.sync());
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
    // §16's active-terminals panel. The queue depth and the §18 offline switch exist only here,
    // so the browser reports them rather than the server inferring them from the socket.
    presence: () => ({
      terminalId: terminalId.value,
      restaurantId,
      role: 'pos',
      pendingCount: orders.pendingCount,
      offline: isTerminalOffline(terminalId.value),
    }),
  });
}

/** A commit action: blocks the other commit actions until it settles. */
async function commit(action: () => Promise<unknown>): Promise<void> {
  committing.value = true;
  try {
    await action();
  } finally {
    committing.value = false;
  }
}

/**
 * An item tap — add, quantity, remove. **Nothing waits for it and nothing is disabled while it
 * runs**, which is what §16's "usable at rush speed" costs in code.
 *
 * The store already made this safe: the queue row and the projection are written before anything
 * is attempted (§14), the local phase of every command is serialized so `baseVersion` is stamped
 * in tap order, and `sync/engine.ts` coalesces a trigger that arrives mid-pass. So the screen can
 * simply stop listening for the answer. It is not careless about *failure*, though: a rejection
 * has no button left to land on, so it is routed to the banner every other error uses.
 */
function tap(action: () => Promise<unknown>): void {
  void action().catch((error: unknown) => {
    orders.lastError = error instanceof Error ? error.message : String(error);
  });
}

const syncNow = (): Promise<void> => commit(() => orders.sync());
const discardHalted = (): Promise<void> => commit(() => orders.discardHalted());
const rebaseHalted = (): Promise<void> => commit(() => orders.rebaseHalted());

const createOrder = (tableNumber: string): Promise<void> =>
  commit(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId === undefined || tableNumber.trim() === '') {
      return;
    }
    await orders.createOrder(terminalId.value, restaurantId, tableNumber.trim());
    cover.value = '';
    // The socket has to start following the new aggregate's room (§13).
    connection.resubscribe();
  });

const addItem = (productId: string): void =>
  tap(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.addItem(terminalId.value, restaurantId, productId);
    }
  });

const removeItem = (productId: string): void =>
  tap(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.removeItem(terminalId.value, restaurantId, productId);
    }
  });

const changeQuantity = (productId: string, quantity: number): void =>
  tap(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.changeQuantity(terminalId.value, restaurantId, productId, quantity);
    }
  });

const sendToKitchen = (): Promise<void> =>
  commit(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.sendToKitchen(terminalId.value, restaurantId);
    }
  });

const pay = (method: PaymentMethod): Promise<void> =>
  commit(async () => {
    const restaurantId = terminal.value?.restaurantId;
    if (restaurantId !== undefined) {
      await orders.pay(terminalId.value, restaurantId, method);
    }
  });

const cancel = (): Promise<void> =>
  commit(async () => {
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
  showEvidence.value = false;
  cover.value = '';
  await start();
});
</script>

<template>
  <section v-if="terminal === undefined">
    <h1 class="text-2xl font-semibold">Unknown terminal “{{ terminalId }}”</h1>
    <p class="mt-2 text-stone-600">Try /pos/pos-1, /pos/pos-2, /pos/bar-1 or /pos/pos-3.</p>
  </section>

  <section v-else class="space-y-4">
    <!-- The terminal switcher. Until M15 nothing in the UI linked anywhere but POS-1, and §19 is
         demoed with two tills side by side — so this is most of what "bar-1 wired up" means. -->
    <nav class="flex flex-wrap items-center gap-2" aria-label="Terminals">
      <RouterLink
        v-for="option in TERMINALS"
        :key="option.id"
        :to="`/pos/${option.id}`"
        class="min-h-12 rounded-lg border px-4 py-2 text-base font-semibold"
        :class="
          option.id === terminalId
            ? option.profile === 'bar'
              ? 'border-amber-600 bg-amber-500 text-white'
              : 'border-emerald-800 bg-emerald-700 text-white'
            : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
        "
      >
        {{ option.label }}
        <span class="ml-1 text-xs font-normal opacity-70">
          {{ option.profile === 'bar' ? 'bar' : option.restaurantId.replace('-restaurant', '') }}
        </span>
      </RouterLink>
    </nav>

    <header
      class="rounded-xl border border-stone-300 border-l-8 bg-white px-5 py-3"
      :class="isBar ? 'border-l-amber-500' : 'border-l-emerald-700'"
    >
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-3xl font-bold tracking-tight">{{ terminal.label }}</h1>
        <span
          class="rounded px-2 py-1 text-sm font-semibold uppercase"
          :class="isBar ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'"
        >
          {{ isBar ? 'Bar' : 'Dining' }}
        </span>

        <button
          type="button"
          class="ml-auto min-h-12 rounded-lg border px-4 text-base font-semibold"
          :class="
            offline
              ? 'border-rose-500 bg-rose-100 text-rose-900'
              : 'border-stone-300 text-stone-700 hover:bg-stone-100'
          "
          @click="toggleOffline"
        >
          {{ offline ? 'Go back online' : 'Simulate Offline' }}
        </button>
      </div>

      <!-- §16's required state, on its own row so it never competes with the buttons for space. -->
      <div class="mt-2 flex flex-wrap items-center gap-2">
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
        <StateBadge v-if="orders.halted" label="BLOCKED" tone="bad" />
        <StateBadge v-if="orders.readError" label="READ FAILED" tone="bad" />
        <StateBadge v-if="persistenceError" label="NOT DURABLE" tone="bad" />
      </div>
    </header>

    <!-- §14.1. The two resolutions come first; the evidence is one tap below and complete. -->
    <div
      v-if="orders.halted"
      class="rounded-xl border-2 border-rose-500 bg-rose-50 px-5 py-4 text-rose-950"
    >
      <p class="text-xl font-bold">
        CONFLICT — this order is blocked.
        <span v-if="headline" class="font-semibold">
          <code>{{ headline.mutationType ?? 'A mutation' }}</code> was sent at v{{
            headline.clientBaseVersion
          }}, the server is at v{{ headline.serverVersion }} ({{ headline.reason }}).
        </span>
      </p>
      <p v-if="headline" class="mt-1 text-base">
        {{ headline.blockedCount }} more mutation(s) queued behind it were never sent. Nothing
        resolves itself — choose one.
      </p>

      <div class="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          class="min-h-14 rounded-lg bg-rose-700 px-6 text-lg font-bold text-white disabled:opacity-40"
          :disabled="committing"
          @click="discardHalted"
        >
          Discard {{ orders.currentQueue.length }}
        </button>
        <button
          type="button"
          class="min-h-14 rounded-lg border-2 border-rose-700 bg-white px-6 text-lg font-bold text-rose-900 disabled:opacity-40"
          :disabled="committing"
          @click="rebaseHalted"
        >
          Rebase onto v{{ orders.canonicalVersion }}
        </button>
        <button
          type="button"
          class="min-h-14 rounded-lg px-4 text-base font-semibold underline"
          @click="showEvidence = !showEvidence"
        >
          {{ showEvidence ? 'Hide the detail' : 'Why?' }}
        </button>
      </div>

      <!-- Not a modal: it opens in place and nothing behind it stops working. -->
      <div v-if="showEvidence" class="mt-4 space-y-3 border-t border-rose-300 pt-3 text-sm">
        <p>
          Everything queued behind the conflicted mutation is <code>BLOCKED</code> and has
          <strong>not</strong> been sent — their <code>baseVersion</code> is provably stale, and
          sending them would produce a cascade of conflicts that looks like a broken client.
          Mutations for other orders keep syncing.
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

        <p>
          A rebase re-issues them one at a time, each with a <strong>new</strong>
          <code>mutationId</code> at the version the previous one produced — never a batch re-stamp,
          because each successful mutation advances the version. Any of them may conflict again: a
          rebase onto a cancelled order fails on the first attempt and the rest stay blocked.
        </p>
      </div>
    </div>

    <p
      v-else-if="orders.pendingCount"
      class="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <span class="flex-1">
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
        class="min-h-12 rounded-lg border border-amber-500 px-4 font-semibold disabled:opacity-40"
        :disabled="committing || offline"
        @click="syncNow"
      >
        Sync now
      </button>
    </p>

    <p
      v-if="offline"
      class="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <strong>{{ terminalId }} is pretending the API is unreachable.</strong>
      The interception is in the API client, not in the stores and not in the browser's own offline
      mode, so the demo is deterministic and every screen keeps one code path. Reads are cut off as
      well as writes — otherwise this terminal would quietly learn what another one did to the order
      and the queued versions would stop being stale. Commands keep working and pile up locally.
    </p>

    <p
      v-if="persistenceError"
      class="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <strong>This device is not storing anything locally.</strong>
      {{ persistenceError }}. Commands still reach the server, but a reload will lose the order on
      screen and — worse — the identity of any mutation that has no answer yet.
    </p>

    <p
      v-if="orders.currentConflict && !orders.halted"
      class="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <strong>CONFLICT — {{ orders.currentConflict.reason }}.</strong>
      Sent at v{{ orders.currentConflict.clientBaseVersion }}, the server is at v{{
        orders.currentConflict.serverVersion
      }}. The canonical order is shown below.
    </p>

    <p
      v-if="orders.readError"
      class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      The order could not be re-read: {{ orders.readError }}. What is shown is the last good read;
      the next event or a reconnect retries.
    </p>

    <p
      v-if="orders.lastError"
      class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      {{ orders.lastError }}
    </p>

    <p
      v-for="strandedId in orders.haltedElsewhere"
      :key="strandedId"
      class="flex flex-wrap items-center gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      <span class="flex-1">
        <strong>Another order queued on this terminal is halted.</strong>
        The halt is per aggregate and this screen is on a different one, so nothing here can resolve
        it — and until it is resolved those mutations are neither sent nor discarded.
        <code class="text-xs">{{ strandedId }}</code>
      </span>
      <button
        type="button"
        class="min-h-12 rounded-lg border border-rose-500 px-4 font-semibold disabled:opacity-40"
        :disabled="committing"
        @click="commit(() => orders.focusOrder(strandedId))"
      >
        Go to it
      </button>
    </p>

    <div class="grid gap-4 lg:grid-cols-5">
      <!-- The menu is the quantity control: ADD_ITEM merges into the line it finds, so a second
           tap on a tile is a second unit, and the badge is what says so. -->
      <div class="rounded-xl border border-stone-300 bg-white p-4 lg:col-span-3">
        <h2 class="mb-3 text-lg font-semibold">
          {{ isBar ? 'Bar' : 'Menu' }}
          <span class="ml-1 text-sm font-normal text-stone-500">tap again for more</span>
        </h2>
        <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <li v-for="tile in tiles" :key="tile.id">
            <button
              type="button"
              class="relative min-h-24 w-full rounded-xl border-2 px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              :class="
                tile.count > 0
                  ? isBar
                    ? 'border-amber-500 bg-amber-50'
                    : 'border-emerald-600 bg-emerald-50'
                  : 'border-stone-300 bg-white hover:bg-stone-50 active:bg-stone-100'
              "
              :disabled="!can.order"
              :aria-label="`Add ${tile.name}, ${tile.count} on the order`"
              @click="addItem(tile.id)"
            >
              <span class="block pr-9 text-lg leading-tight font-semibold">{{ tile.name }}</span>
              <span class="mt-1 block text-base text-stone-600">{{ money(tile.priceCents) }}</span>
              <span
                v-if="tile.count > 0"
                class="absolute top-2 right-2 inline-flex h-9 min-w-9 items-center justify-center rounded-full px-2 text-lg font-bold text-white tabular-nums"
                :class="isBar ? 'bg-amber-600' : 'bg-emerald-700'"
              >
                {{ tile.count }}
              </span>
            </button>
          </li>
        </ul>
      </div>

      <div class="rounded-xl border border-stone-300 bg-white p-4 lg:col-span-2">
        <h2 class="mb-3 text-lg font-semibold">
          {{ shown ? `${noun} ${shown.tableNumber}` : `Open a ${noun.toLowerCase()}` }}
        </h2>

        <!-- No keyboard on the critical path: the common covers are one tap, and the input is
             still there for anything else. Still no modal anywhere on this screen. -->
        <div v-if="!shown" class="space-y-3">
          <ul class="grid grid-cols-3 gap-2">
            <li v-for="option in covers" :key="option">
              <button
                type="button"
                class="min-h-16 w-full rounded-xl border-2 border-stone-300 text-lg font-bold hover:bg-stone-50 disabled:opacity-40"
                :disabled="committing || orders.halted"
                @click="createOrder(option)"
              >
                {{ noun }} {{ option }}
              </button>
            </li>
          </ul>
          <form class="flex items-end gap-2" @submit.prevent="createOrder(cover)">
            <label class="flex-1 text-sm">
              <span class="mb-1 block text-stone-600">Another {{ noun.toLowerCase() }}</span>
              <input
                v-model="cover"
                class="min-h-12 w-full rounded-lg border border-stone-300 px-3 text-base"
                :placeholder="noun"
              />
            </label>
            <button
              type="submit"
              class="min-h-12 rounded-lg bg-emerald-700 px-5 font-semibold text-white disabled:opacity-40"
              :disabled="committing || orders.halted || cover.trim() === ''"
            >
              Open
            </button>
          </form>
        </div>

        <div v-else class="space-y-3">
          <p class="text-sm text-stone-600">
            {{ shown.status }} · <code class="text-xs">{{ shown.id }}</code>
          </p>

          <ul v-if="shown.items.length" class="divide-y divide-stone-200">
            <li v-for="item in shown.items" :key="item.productId" class="py-2">
              <div class="flex items-center gap-2">
                <span class="flex-1 text-lg leading-tight font-medium">{{ item.name }}</span>
                <span class="w-20 text-right text-lg tabular-nums">
                  {{ money(item.quantity * item.unitPriceCents) }}
                </span>
              </div>
              <div class="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  class="h-14 w-14 rounded-lg border-2 border-stone-300 text-2xl leading-none font-bold hover:bg-stone-50 disabled:opacity-30"
                  :disabled="!can.order"
                  :aria-label="`One fewer ${item.name}`"
                  @click="changeQuantity(item.productId, item.quantity - 1)"
                >
                  −
                </button>
                <span class="w-12 text-center text-2xl font-bold tabular-nums">
                  {{ item.quantity }}
                </span>
                <button
                  type="button"
                  class="h-14 w-14 rounded-lg border-2 border-stone-300 text-2xl leading-none font-bold hover:bg-stone-50 disabled:opacity-30"
                  :disabled="!can.order"
                  :aria-label="`One more ${item.name}`"
                  @click="changeQuantity(item.productId, item.quantity + 1)"
                >
                  +
                </button>
                <button
                  type="button"
                  class="ml-auto min-h-12 rounded-lg border border-stone-300 px-4 disabled:opacity-30"
                  :disabled="!can.order"
                  @click="removeItem(item.productId)"
                >
                  Remove
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="py-4 text-base text-stone-500">No items yet — tap the menu.</p>

          <p class="flex justify-between border-t-2 border-stone-300 pt-3 text-2xl font-bold">
            <span>Total</span>
            <span class="tabular-nums">{{ money(shown.totalCents) }}</span>
          </p>

          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              class="col-span-2 min-h-16 rounded-xl bg-[#17201c] text-lg font-bold text-white disabled:opacity-40"
              :disabled="!can.send || committing"
              @click="sendToKitchen"
            >
              Send to kitchen
            </button>
            <button
              type="button"
              class="min-h-16 rounded-xl bg-emerald-700 text-lg font-bold text-white disabled:opacity-40"
              :disabled="!can.pay || committing"
              @click="pay('CARD')"
            >
              Pay card
            </button>
            <button
              type="button"
              class="min-h-16 rounded-xl bg-emerald-700 text-lg font-bold text-white disabled:opacity-40"
              :disabled="!can.pay || committing"
              @click="pay('CASH')"
            >
              Pay cash
            </button>
            <button
              type="button"
              class="min-h-14 rounded-lg border-2 border-rose-400 font-semibold text-rose-800 disabled:opacity-40"
              :disabled="!can.cancel || committing"
              @click="cancel"
            >
              Cancel order
            </button>
            <button
              type="button"
              class="min-h-14 rounded-lg border-2 border-stone-300 font-semibold disabled:opacity-40"
              :disabled="committing || orders.halted"
              @click="orders.clear()"
            >
              New {{ noun.toLowerCase() }}
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
