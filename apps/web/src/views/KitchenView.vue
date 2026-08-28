<script setup lang="ts">
import type { DomainEvent } from '@pos/contracts';
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRoute } from 'vue-router';

import StateBadge from '../components/StateBadge.vue';
import { useConnectionStore } from '../stores/connection';
import { useKitchenStore } from '../stores/kitchen';

const route = useRoute();
const kitchen = useKitchenStore();
const connection = useConnectionStore();

const restaurantId = computed(() => String(route.query.restaurantId ?? 'demo-restaurant'));

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const ticketTotal = (items: { quantity: number; unitPriceCents: number }[]): number =>
  items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);

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
    // broadcast and the projection are written by two different consumers (ADR 006).
    refresh: (event: DomainEvent | undefined) =>
      kitchen.load(
        restaurantId.value,
        event === undefined ? undefined : { orderId: event.aggregateId, version: event.version },
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
      v-if="kitchen.lagging"
      class="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      A broadcast arrived before the kitchen consumer had written its projection, and the retry
      budget ran out. The ticket appears as soon as the projection catches up and the next event
      lands — or on a reload.
    </p>

    <p class="text-sm text-stone-600">
      Read from the <code>kitchen_tickets</code> projection. <strong>Start Preparing</strong> and
      <strong>Mark Ready</strong> arrive in M5, when they become real mutations with their own
      <code>mutationId</code> and <code>baseVersion</code>.
    </p>

    <div>
      <h2 class="mb-3 text-sm font-semibold tracking-wide text-stone-600 uppercase">
        New ({{ kitchen.tickets.length }})
      </h2>

      <p v-if="kitchen.loaded && kitchen.tickets.length === 0" class="text-stone-500">
        Nothing sent to the kitchen yet.
      </p>

      <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <li
          v-for="ticket in kitchen.tickets"
          :key="ticket.orderId"
          class="rounded border border-stone-300 bg-white p-4"
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
          <p class="flex justify-between border-t border-stone-200 pt-2 text-sm font-semibold">
            <span>{{ ticket.state }}</span>
            <span>{{ money(ticketTotal(ticket.items)) }}</span>
          </p>
        </li>
      </ul>
    </div>
  </section>
</template>
