<script setup lang="ts">
import type { DomainEvent, KitchenTicket, KitchenTicketState } from '@pos/contracts';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import StateBadge from '../components/StateBadge.vue';
import { useConnectionStore } from '../stores/connection';
import {
  expectationFor,
  nextCommand,
  useKitchenStore,
  type KitchenCommand,
} from '../stores/kitchen';

const route = useRoute();
const kitchen = useKitchenStore();
const connection = useConnectionStore();

const restaurantId = computed(() => String(route.query.restaurantId ?? 'demo-restaurant'));
/**
 * In flight *per ticket*, not for the rail. The store already keeps unresolved commands per order
 * because that is the aggregate; a single shared flag would throw that away at the last step and
 * let one slow request stop a kitchen with twelve orders on the pass from touching any of them.
 */
const busyOrders = ref(new Set<string>());
const isBusy = (orderId: string): boolean => busyOrders.value.has(orderId);

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const ticketTotal = (items: { quantity: number; unitPriceCents: number }[]): number =>
  items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);

/** The rail, left to right. A cancelled ticket stays visible so the line sees it stop cooking. */
const COLUMNS: { state: KitchenTicketState; title: string }[] = [
  { state: 'SENT_TO_KITCHEN', title: 'New' },
  { state: 'PREPARING', title: 'Preparing' },
  { state: 'READY', title: 'Ready' },
  { state: 'CANCELLED', title: 'Cancelled' },
];

const COMMAND_LABELS: Record<KitchenCommand, string> = {
  preparing: 'Start preparing',
  ready: 'Mark ready',
};

const inColumn = (state: KitchenTicketState): KitchenTicket[] =>
  kitchen.tickets.filter((ticket) => ticket.state === state);

async function runFor(orderId: string, action: () => Promise<unknown>): Promise<void> {
  busyOrders.value.add(orderId);
  try {
    await action();
  } finally {
    busyOrders.value.delete(orderId);
  }
}

const send = (orderId: string, command: KitchenCommand): Promise<void> =>
  runFor(orderId, () => kitchen.command(orderId, command));

const retry = (orderId: string): Promise<void> => runFor(orderId, () => kitchen.retry(orderId));

onMounted(async () => {
  await kitchen.load(restaurantId.value);
  await connection.start({
    restaurantId: restaurantId.value,
    role: 'kitchen',
    currentOrderId: () => undefined,
    // The projection row records the event version it was built from, so the same version gate
    // that guards the POS works here without a second rule (§12.1, §12.2).
    heldVersion: (aggregateId) =>
      kitchen.tickets.find((ticket) => ticket.orderId === aggregateId)?.sourceEventVersion ?? 0,
    // The event is passed on so the store can wait for the projection to catch up to it: the
    // broadcast and the projection are written by two different consumers (ADR 006). Not every
    // event earns that wait, though — `expectationFor` is what decides.
    refresh: (event: DomainEvent | undefined) =>
      kitchen.load(
        restaurantId.value,
        event === undefined ? undefined : expectationFor(event, kitchen.tickets),
      ),
  });
});

onBeforeUnmount(() => {
  connection.stop();
});
</script>

<template>
  <section class="space-y-6">
    <header class="flex flex-wrap items-center gap-3">
      <h1 class="mr-2 text-2xl font-semibold">Kitchen</h1>
      <StateBadge :label="restaurantId" />
      <StateBadge
        :label="`WS ${connection.socketState}`"
        :tone="connection.socketState === 'CONNECTED' ? 'ok' : 'warn'"
      />
      <StateBadge :label="connection.transport" :tone="connection.pushEnabled ? 'ok' : 'warn'" />
      <StateBadge v-if="kitchen.lagging" label="PROJECTION LAG" tone="warn" />
      <StateBadge v-if="kitchen.loadError" label="READ FAILED" tone="bad" />
    </header>

    <p
      v-if="kitchen.loadError"
      class="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
    >
      The ticket list could not be read: {{ kitchen.loadError }}. What is shown below is the last
      good read. The next event or a reconnect retries.
    </p>

    <p
      v-if="kitchen.commandError"
      class="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      {{ kitchen.commandError }}
    </p>

    <p
      v-if="kitchen.lagging"
      class="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      A broadcast arrived before the kitchen consumer had written its projection, and the retry
      budget ran out. The ticket appears as soon as the projection catches up and the next event
      lands — or on a reload.
    </p>

    <p class="text-sm text-stone-600">
      Read from the <code>kitchen_tickets</code> projection. Both commands are real mutations with
      their own <code>mutationId</code>, sent at the version the projection knows — so two displays
      pressing the same button produce one success and one conflict (§21.10, ADR 012).
    </p>

    <div class="grid gap-6 lg:grid-cols-4">
      <div v-for="column in COLUMNS" :key="column.state">
        <h2 class="mb-3 text-sm font-semibold tracking-wide text-stone-600 uppercase">
          {{ column.title }} ({{ inColumn(column.state).length }})
        </h2>

        <p
          v-if="kitchen.loaded && inColumn(column.state).length === 0"
          class="text-sm text-stone-400"
        >
          —
        </p>

        <ul class="space-y-4">
          <li
            v-for="ticket in inColumn(column.state)"
            :key="ticket.orderId"
            class="rounded border border-stone-300 bg-white p-4"
            :class="{ 'opacity-60': ticket.state === 'CANCELLED' }"
          >
            <div class="mb-2 flex items-center justify-between">
              <strong class="text-lg">Table {{ ticket.tableNumber }}</strong>
              <StateBadge :label="`from v${ticket.sourceEventVersion}`" />
            </div>

            <ul class="mb-3 space-y-1 text-sm">
              <li v-for="item in ticket.items" :key="item.productId">
                {{ item.quantity }} × {{ item.name }}
              </li>
            </ul>

            <p
              class="flex justify-between border-t border-stone-200 pt-2 text-sm font-semibold"
              :class="{ 'mb-3': nextCommand(ticket.state) !== undefined }"
            >
              <span>{{ ticket.state }}</span>
              <span>{{ money(ticketTotal(ticket.items)) }}</span>
            </p>

            <p
              v-if="kitchen.conflictByOrder.get(ticket.orderId)"
              class="mb-3 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-900"
            >
              Refused: {{ kitchen.conflictByOrder.get(ticket.orderId) }}. The card above is what the
              projection now says.
            </p>

            <div
              v-if="kitchen.pendingByOrder.get(ticket.orderId)"
              class="space-y-2 rounded border border-amber-300 bg-amber-50 px-2 py-2 text-xs text-amber-900"
            >
              <p>
                No answer came back. Retrying reuses the same <code>mutationId</code>, so an already
                applied command answers <code>ALREADY_APPLIED</code> instead of running twice.
              </p>
              <span class="flex gap-2">
                <button
                  type="button"
                  class="rounded border border-amber-500 px-2 py-1 font-medium disabled:opacity-40"
                  :disabled="isBusy(ticket.orderId)"
                  @click="retry(ticket.orderId)"
                >
                  Retry
                </button>
                <button
                  type="button"
                  class="rounded border border-amber-400 px-2 py-1 disabled:opacity-40"
                  :disabled="isBusy(ticket.orderId)"
                  @click="kitchen.discard(ticket.orderId)"
                >
                  Discard
                </button>
              </span>
            </div>

            <button
              v-else-if="nextCommand(ticket.state)"
              type="button"
              class="w-full rounded bg-[#17201c] px-3 py-2 font-medium text-white disabled:opacity-40"
              :disabled="isBusy(ticket.orderId)"
              @click="send(ticket.orderId, nextCommand(ticket.state)!)"
            >
              {{ COMMAND_LABELS[nextCommand(ticket.state)!] }}
            </button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
