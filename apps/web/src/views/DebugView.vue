<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import SimulatorPanel from '../components/SimulatorPanel.vue';
import StateBadge from '../components/StateBadge.vue';
import {
  dependencyBadges,
  formatCounter,
  formatTime,
  lagBadge,
  outboxRowBadges,
  presenceBadges,
  printJobBadge,
  shortId,
} from '../domain/debug-view';
import { useDebugStore } from '../stores/debug';

/**
 * §16's debug screen: dependency status with hard-vs-soft marked, active terminals, the event
 * stream, conflict history, outbox state including dead-lettered rows, print job state, and the
 * §20 counters with their provenance.
 *
 * §18's failure simulator is the one section that writes, and it is a component of its own
 * (`SimulatorPanel`) rather than more markup here: everything above polls and renders, and mixing
 * the eleven buttons into that would have made the read path harder to read. The feature-flag
 * toggles are M13's and are named below rather than omitted, so the page does not quietly claim
 * §16 is finished.
 */
const debug = useDebugStore();

/**
 * A clock that ticks with the poll, so presence staleness is computed against something reactive.
 * `Date.now()` inside a computed would be read once and never re-evaluated.
 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  debug.start();
  clock = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
});

onBeforeUnmount(() => {
  debug.stop();
  if (clock !== undefined) {
    clearInterval(clock);
  }
});

const terminals = computed(() => debug.metrics?.terminals ?? []);
const consumerGroups = computed(() => debug.dependencies?.consumerGroups ?? []);
const backlog = computed(() => debug.dependencies?.outbox);
</script>

<template>
  <section class="space-y-8">
    <header class="flex flex-wrap items-baseline justify-between gap-3">
      <div>
        <h1 class="text-3xl font-semibold">Debug</h1>
        <p class="text-sm text-stone-600">
          Every number below says where it comes from, and every control at the bottom says where
          its switch lives. Polling every 2 s; the flag toggles are M13.
        </p>
      </div>
      <p class="text-sm text-stone-600">
        Last read {{ debug.lastLoadedAt === undefined ? '—' : formatTime(debug.lastLoadedAt) }}
      </p>
    </header>

    <!-- Dependencies -------------------------------------------------------------------------->
    <article class="rounded border border-stone-300 bg-white p-4">
      <h2 class="mb-3 text-lg font-semibold">Dependencies</h2>
      <p v-if="debug.errors.dependencies" class="mb-3 text-sm text-rose-700">
        {{ debug.errors.dependencies }}
      </p>
      <ul class="space-y-2">
        <li
          v-for="report in debug.dependencies?.dependencies ?? []"
          :key="report.name"
          class="flex flex-wrap items-center gap-2 border-b border-stone-200 pb-2 last:border-0"
        >
          <strong class="w-24">{{ report.name }}</strong>
          <StateBadge
            v-for="badge in dependencyBadges(report)"
            :key="badge.label"
            :label="badge.label"
            :tone="badge.tone"
          />
          <span class="text-sm text-stone-600">{{ report.latencyMs }} ms</span>
          <span class="text-sm text-stone-600">{{ report.error ?? report.impact }}</span>
        </li>
      </ul>

      <div class="mt-4 flex flex-wrap items-center gap-4">
        <div v-for="group in consumerGroups" :key="group.groupId" class="flex items-center gap-2">
          <strong class="text-sm">{{ group.groupId }}</strong>
          <StateBadge :label="lagBadge(group).label" :tone="lagBadge(group).tone" />
          <span v-if="group.error" class="text-xs text-stone-600">{{ group.error }}</span>
        </div>
        <p v-if="consumerGroups.length === 0" class="text-sm text-stone-600">
          No consumer lag reported: this API instance has no Kafka admin client.
        </p>
      </div>

      <p v-if="backlog" class="mt-3 text-sm text-stone-600">
        Outbox backlog: {{ backlog.pending }} pending, {{ backlog.deadLettered }} dead-lettered,
        oldest pending
        {{
          backlog.oldestPendingAgeSeconds === null ? '—' : `${backlog.oldestPendingAgeSeconds} s`
        }}
        old.
      </p>
    </article>

    <!-- Active terminals ---------------------------------------------------------------------->
    <article class="rounded border border-stone-300 bg-white p-4">
      <h2 class="mb-1 text-lg font-semibold">Active terminals</h2>
      <p class="mb-3 text-sm text-stone-600">
        Presence lives in Redis with a TTL and is refreshed by a heartbeat from each browser, so an
        entry disappears on its own when a terminal stops reporting. Pending counts and the offline
        switch are reported by the client — nothing else can know them.
      </p>
      <p v-if="debug.metrics?.presenceError" class="mb-3 text-sm text-amber-700">
        {{ debug.metrics.presenceError }}
      </p>
      <ul class="space-y-2">
        <li
          v-for="entry in terminals"
          :key="entry.terminalId"
          class="flex flex-wrap items-center gap-2 border-b border-stone-200 pb-2 last:border-0"
        >
          <strong class="w-32">{{ entry.terminalId }}</strong>
          <StateBadge
            v-for="badge in presenceBadges(entry, now)"
            :key="badge.label"
            :label="badge.label"
            :tone="badge.tone"
          />
          <span class="text-sm text-stone-600">{{ entry.restaurantId }} · {{ entry.role }}</span>
          <span class="text-sm text-stone-600">last seen {{ formatTime(entry.lastSeenAt) }}</span>
        </li>
        <li v-if="terminals.length === 0" class="text-sm text-stone-600">
          No terminal is connected.
        </li>
      </ul>
    </article>

    <!-- Events -------------------------------------------------------------------------------->
    <article class="rounded border border-stone-300 bg-white p-4">
      <h2 class="mb-3 text-lg font-semibold">Recent domain events</h2>
      <p v-if="debug.errors.events" class="mb-3 text-sm text-rose-700">{{ debug.errors.events }}</p>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs uppercase text-stone-500">
            <tr>
              <th class="py-1 pr-3">Time</th>
              <th class="py-1 pr-3">Event</th>
              <th class="py-1 pr-3">Order</th>
              <th class="py-1 pr-3">v</th>
              <th class="py-1 pr-3">Published</th>
              <th class="py-1 pr-3">Consumed by</th>
              <th class="py-1 pr-3">Trace</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="event in debug.events?.events ?? []"
              :key="event.eventId"
              class="border-t border-stone-200"
            >
              <td class="py-1 pr-3 whitespace-nowrap">{{ formatTime(event.createdAt) }}</td>
              <td class="py-1 pr-3">{{ event.eventType }}</td>
              <td class="py-1 pr-3 font-mono text-xs">{{ shortId(event.aggregateId) }}</td>
              <td class="py-1 pr-3">{{ event.version }}</td>
              <td class="py-1 pr-3">
                <StateBadge v-if="event.deadLetteredAt !== null" label="DEAD-LETTERED" tone="bad" />
                <StateBadge v-else-if="event.publishedAt === null" label="PENDING" tone="warn" />
                <span v-else>{{ formatTime(event.publishedAt) }}</span>
              </td>
              <td class="py-1 pr-3">
                {{ event.consumedBy.length === 0 ? '—' : event.consumedBy.join(', ') }}
              </td>
              <td class="py-1 pr-3 font-mono text-xs">
                {{ event.traceId === null ? '—' : shortId(event.traceId) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="(debug.events?.events.length ?? 0) === 0" class="text-sm text-stone-600">
        No events yet.
      </p>
    </article>

    <!-- Conflicts ----------------------------------------------------------------------------->
    <article class="rounded border border-stone-300 bg-white p-4">
      <h2 class="mb-1 text-lg font-semibold">Conflict history</h2>
      <p class="mb-3 text-sm text-stone-600">
        {{ debug.conflicts?.total ?? 0 }} in total, {{ debug.conflicts?.unresolved ?? 0 }} with no
        resolution — each of those is a client queue still halted under §14.1.
      </p>
      <p v-if="debug.errors.conflicts" class="mb-3 text-sm text-rose-700">
        {{ debug.errors.conflicts }}
      </p>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs uppercase text-stone-500">
            <tr>
              <th class="py-1 pr-3">Time</th>
              <th class="py-1 pr-3">Terminal</th>
              <th class="py-1 pr-3">Mutation</th>
              <th class="py-1 pr-3">Order</th>
              <th class="py-1 pr-3">Client v → server v</th>
              <th class="py-1 pr-3">Server status</th>
              <th class="py-1 pr-3">Resolution</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in debug.conflicts?.conflicts ?? []"
              :key="row.id"
              class="border-t border-stone-200"
            >
              <td class="py-1 pr-3 whitespace-nowrap">{{ formatTime(row.createdAt) }}</td>
              <td class="py-1 pr-3">{{ row.terminalId }}</td>
              <td class="py-1 pr-3">
                {{ row.mutationType }}
                <span class="font-mono text-xs text-stone-500">{{ shortId(row.mutationId) }}</span>
              </td>
              <td class="py-1 pr-3 font-mono text-xs">{{ shortId(row.orderId) }}</td>
              <td class="py-1 pr-3">{{ row.clientBaseVersion }} → {{ row.serverVersion }}</td>
              <td class="py-1 pr-3">{{ row.serverStatus }}</td>
              <td class="py-1 pr-3">
                <StateBadge v-if="row.resolution === null" label="BLOCKED" tone="warn" />
                <span v-else>{{ row.resolution }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="(debug.conflicts?.conflicts.length ?? 0) === 0" class="text-sm text-stone-600">
        No conflicts recorded.
      </p>
    </article>

    <!-- Delivery: outbox and print jobs -------------------------------------------------------->
    <article class="rounded border border-stone-300 bg-white p-4">
      <h2 class="mb-1 text-lg font-semibold">Delivery</h2>
      <p class="mb-3 text-sm text-stone-600">
        Two at-least-once pipelines, each with attempts, a last error and a dead-letter state. A
        duplicate kitchen ticket can physically print (§12.3); that is the accepted trade.
      </p>
      <p v-if="debug.errors.outbox" class="mb-3 text-sm text-rose-700">{{ debug.errors.outbox }}</p>

      <h3 class="mt-3 mb-2 text-sm font-semibold uppercase tracking-wide text-stone-600">
        Outbox — {{ debug.outbox?.outbox.pending ?? 0 }} pending,
        {{ debug.outbox?.outbox.published ?? 0 }} published,
        {{ debug.outbox?.outbox.deadLettered ?? 0 }} dead-lettered
      </h3>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs uppercase text-stone-500">
            <tr>
              <th class="py-1 pr-3">Event</th>
              <th class="py-1 pr-3">State</th>
              <th class="py-1 pr-3">Attempts</th>
              <th class="py-1 pr-3">Next attempt</th>
              <th class="py-1 pr-3">Last error</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in debug.outbox?.outbox.rows ?? []"
              :key="row.id"
              class="border-t border-stone-200"
            >
              <td class="py-1 pr-3">
                {{ row.eventType }}
                <span class="font-mono text-xs text-stone-500">
                  {{ shortId(row.aggregateId) }} v{{ row.eventVersion }}
                </span>
              </td>
              <td class="py-1 pr-3">
                <span class="flex flex-wrap gap-1">
                  <StateBadge
                    v-for="badge in outboxRowBadges(row)"
                    :key="badge.label"
                    :label="badge.label"
                    :tone="badge.tone"
                  />
                </span>
              </td>
              <td class="py-1 pr-3">{{ row.attemptCount }}</td>
              <td class="py-1 pr-3 whitespace-nowrap">{{ formatTime(row.nextAttemptAt) }}</td>
              <td class="py-1 pr-3 text-xs text-stone-600">{{ row.lastError ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="(debug.outbox?.outbox.rows.length ?? 0) === 0" class="text-sm text-stone-600">
        The outbox is empty.
      </p>

      <h3 class="mt-6 mb-2 text-sm font-semibold uppercase tracking-wide text-stone-600">
        Print jobs — {{ debug.outbox?.printJobs.pending ?? 0 }} pending,
        {{ debug.outbox?.printJobs.printed ?? 0 }} printed,
        {{ debug.outbox?.printJobs.failed ?? 0 }} failing,
        {{ debug.outbox?.printJobs.deadLettered ?? 0 }} dead-lettered
      </h3>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs uppercase text-stone-500">
            <tr>
              <th class="py-1 pr-3">Order</th>
              <th class="py-1 pr-3">State</th>
              <th class="py-1 pr-3">Attempts</th>
              <th class="py-1 pr-3">Printed</th>
              <th class="py-1 pr-3">Last error</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="job in debug.outbox?.printJobs.rows ?? []"
              :key="job.id"
              class="border-t border-stone-200"
            >
              <td class="py-1 pr-3 font-mono text-xs">{{ shortId(job.orderId) }}</td>
              <td class="py-1 pr-3">
                <StateBadge
                  :label="printJobBadge(job.state).label"
                  :tone="printJobBadge(job.state).tone"
                />
              </td>
              <td class="py-1 pr-3">{{ job.attemptCount }}</td>
              <td class="py-1 pr-3 whitespace-nowrap">{{ formatTime(job.printedAt) }}</td>
              <td class="py-1 pr-3 text-xs text-stone-600">{{ job.lastError ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="(debug.outbox?.printJobs.rows.length ?? 0) === 0" class="text-sm text-stone-600">
        Nothing has been sent to the printer yet.
      </p>
    </article>

    <!-- Counters ------------------------------------------------------------------------------>
    <article class="rounded border border-stone-300 bg-white p-4">
      <h2 class="mb-1 text-lg font-semibold">Counters</h2>
      <p class="mb-3 text-sm text-stone-600">
        §20's list, grouped by where each number is kept. This API instance has been up for
        {{ debug.metrics?.processUptimeSeconds ?? 0 }} s.
      </p>
      <p v-if="debug.errors.metrics" class="mb-3 text-sm text-rose-700">
        {{ debug.errors.metrics }}
      </p>

      <div v-for="group in debug.counterGroups" :key="group.source" class="mb-6 last:mb-0">
        <h3 class="text-sm font-semibold uppercase tracking-wide text-stone-600">
          {{ group.title }}
        </h3>
        <p class="mb-2 text-xs text-stone-500">{{ group.caveat }}</p>
        <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="reading in group.readings"
            :key="reading.name"
            class="rounded border border-stone-200 px-3 py-2"
          >
            <dt class="text-xs text-stone-600">{{ reading.name }}</dt>
            <dd class="text-xl font-semibold tabular-nums">{{ formatCounter(reading.value) }}</dd>
            <p v-if="reading.note" class="text-xs text-stone-500">{{ reading.note }}</p>
          </div>
        </dl>
      </div>
    </article>

    <!-- §18 ------------------------------------------------------------------------------------>
    <SimulatorPanel />

    <!-- The one §16 section this milestone does not own ------------------------------------------>
    <article class="rounded border border-dashed border-stone-300 p-4 text-sm text-stone-600">
      <h2 class="mb-2 text-lg font-semibold text-stone-800">Not on this page yet</h2>
      <p><strong>Feature flag toggles</strong> — M13, together with the polling transport.</p>
    </article>
  </section>
</template>
