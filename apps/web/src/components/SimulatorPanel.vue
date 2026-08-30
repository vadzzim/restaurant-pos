<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { formatTime } from '../domain/debug-view';
import { useSimulatorStore } from '../stores/simulator';
import StateBadge from './StateBadge.vue';

/**
 * §18's failure simulator: all eleven controls, grouped by **where the switch lives**, because
 * that is the difference worth showing. The four in the first group are rows in PostgreSQL — they
 * are fleet-wide and they outlive the worker that obeys them. The seven in the second are refs in
 * this browser tab and die with it.
 *
 * Every control names the number on this page that moves when it fires, and the log at the bottom
 * says what each press actually did — a one-shot armed here fires two screens away, and a number
 * that changed a poll later is not the same as knowing the control worked.
 */
const simulator = useSimulatorStore();

/** The delay is the one control with a value rather than a state, so it gets a field. */
const delayInput = ref(0);

const OFFLINE_TERMINALS = ['pos-1', 'pos-2'] as const;

type ArmName = 'duplicate-next-mutation' | 'reuse-mutation-id' | 'create-version-conflict';

onMounted(() => {
  simulator.start();
});

onBeforeUnmount(() => {
  simulator.stop();
});

const outbox = computed(() => simulator.state?.outbox);
const printer = computed(() => simulator.state?.printer);
const armed = (name: ArmName): boolean => simulator.arms[name];
</script>

<template>
  <article class="rounded border border-stone-300 bg-white p-4">
    <h2 class="text-lg font-semibold">Failure simulator</h2>
    <p class="mb-4 text-sm text-stone-600">
      §18's eleven controls. Each one names the number above that moves when it fires.
    </p>

    <p v-if="simulator.error" class="mb-3 text-sm text-rose-700">{{ simulator.error }}</p>

    <!-- Server-side switches ------------------------------------------------------------------>
    <h3 class="mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-800">
      Server
      <StateBadge label="postgres row" tone="neutral" />
      <span class="text-xs font-normal text-stone-600">
        fleet-wide, survives a worker restart, seen within one OUTBOX_POLL_MS
      </span>
    </h3>

    <ul class="mt-2 space-y-2">
      <li class="flex flex-wrap items-center gap-3 border-b border-stone-200 pb-2">
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          :disabled="outbox === undefined || simulator.busy === 'outbox-pause'"
          @click="simulator.pauseOutbox(!(outbox?.paused ?? false))"
        >
          {{ outbox?.paused ? 'Resume Outbox Publisher' : 'Pause Outbox Publisher' }}
        </button>
        <StateBadge
          :label="outbox?.paused ? 'paused' : 'running'"
          :tone="outbox?.paused ? 'bad' : 'ok'"
        />
        <span class="text-xs text-stone-600">
          watch <strong>outboxEventsPending</strong> climb and the backlog age grow
        </span>
      </li>

      <li class="flex flex-wrap items-center gap-3 border-b border-stone-200 pb-2">
        <div class="flex w-64 items-center gap-2">
          <button
            type="button"
            class="flex-1 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            :disabled="simulator.busy === 'outbox-delay'"
            @click="simulator.delayOutbox(delayInput)"
          >
            Delay Outbox Publishing
          </button>
          <input
            v-model.number="delayInput"
            type="number"
            min="0"
            aria-label="Publish delay in milliseconds"
            class="w-20 rounded border border-stone-300 px-2 py-1 text-sm tabular-nums"
          />
        </div>
        <StateBadge
          :label="`${outbox?.publishDelayMs ?? 0} ms`"
          :tone="(outbox?.publishDelayMs ?? 0) > 0 ? 'warn' : 'ok'"
        />
        <span class="text-xs text-stone-600">
          rows sit <strong>PENDING</strong> between polls. The API refuses a delay past half the
          publisher's lease, which would be a pause wearing a delay's clothes.
        </span>
      </li>

      <li class="flex flex-wrap items-center gap-3 border-b border-stone-200 pb-2">
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          :disabled="printer === undefined || simulator.busy === 'printer-fail'"
          @click="simulator.failPrinter(!(printer?.failing ?? false))"
        >
          {{ printer?.failing ? 'Fix Printer' : 'Fail Printer' }}
        </button>
        <StateBadge
          :label="printer?.failing ? 'failing' : 'healthy'"
          :tone="printer?.failing ? 'bad' : 'ok'"
        />
        <span class="text-xs text-stone-600">
          watch <strong>print_jobs</strong> go FAILED, then DEAD_LETTER after the retries (§19.9)
        </span>
      </li>

      <li class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          :disabled="simulator.busy === 'replay-last-event'"
          @click="simulator.replayLastEvent()"
        >
          Replay Last Kafka Event
        </button>
        <StateBadge label="one-shot" tone="neutral" />
        <span class="text-xs text-stone-600">
          the newest published row goes back to pending and is sent again;
          <strong>duplicateKafkaEventsPrevented</strong> climbs and the projection does not move
          (§19.6). The published count drops by one while it is in flight.
        </span>
      </li>
    </ul>

    <!-- Client-side switches ------------------------------------------------------------------>
    <h3 class="mt-6 flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-800">
      This browser
      <StateBadge label="tab-local" tone="neutral" />
      <span class="text-xs font-normal text-stone-600">
        dies with the tab, and does not cross tabs — arm one here, then walk to /pos
      </span>
    </h3>

    <ul class="mt-2 space-y-2">
      <li
        v-for="terminal in OFFLINE_TERMINALS"
        :key="terminal"
        class="flex flex-wrap items-center gap-3 border-b border-stone-200 pb-2"
      >
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white"
          @click="simulator.toggleOffline(terminal)"
        >
          Simulate {{ terminal.toUpperCase() }} Offline
        </button>
        <StateBadge
          :label="simulator.offlineTerminal(terminal) ? 'offline' : 'online'"
          :tone="simulator.offlineTerminal(terminal) ? 'bad' : 'ok'"
        />
        <span class="text-xs text-stone-600">
          its presence row above shows <strong>OFFLINE</strong> with a rising PENDING count
        </span>
      </li>

      <li class="flex flex-wrap items-center gap-3 border-b border-stone-200 pb-2">
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white"
          @click="simulator.toggleArmed('duplicate-next-mutation', 'Duplicate Next Mutation')"
        >
          Duplicate Next Mutation
        </button>
        <StateBadge
          :label="armed('duplicate-next-mutation') ? 'armed' : 'idle'"
          :tone="armed('duplicate-next-mutation') ? 'warn' : 'neutral'"
        />
        <span class="text-xs text-stone-600">
          the same body is sent twice; <strong>duplicateMutationsPrevented</strong> +1 and the item
          is not doubled (§19.4)
        </span>
      </li>

      <li class="flex flex-wrap items-center gap-3 border-b border-stone-200 pb-2">
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white"
          @click="simulator.toggleArmed('reuse-mutation-id', 'Reuse Mutation Id With New Payload')"
        >
          Reuse Mutation Id With New Payload
        </button>
        <StateBadge
          :label="armed('reuse-mutation-id') ? 'armed' : 'idle'"
          :tone="armed('reuse-mutation-id') ? 'warn' : 'neutral'"
        />
        <span class="text-xs text-stone-600">
          same id, a different body; <strong>mutationIdReuseRejected</strong> +1 and the server
          refuses rather than returning the stale result (§19.5)
        </span>
      </li>

      <li class="flex flex-wrap items-center gap-3 border-b border-stone-200 pb-2">
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white"
          @click="simulator.toggleArmed('create-version-conflict', 'Create Version Conflict')"
        >
          Create Version Conflict
        </button>
        <StateBadge
          :label="armed('create-version-conflict') ? 'armed' : 'idle'"
          :tone="armed('create-version-conflict') ? 'warn' : 'neutral'"
        />
        <span class="text-xs text-stone-600">
          the next mutation goes one version low, so the queue halts under §14.1 and a
          <strong>conflict_log</strong> row appears above. It waits for a mutation at v1 or higher:
          creation is defined at v0.
        </span>
      </li>

      <li class="flex flex-wrap items-center gap-3 border-b border-stone-200 pb-2">
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white"
          @click="simulator.toggleLatched('socket-disabled', 'Disconnect WebSocket')"
        >
          Disconnect WebSocket
        </button>
        <StateBadge
          :label="simulator.latches['socket-disabled'] ? 'socket off' : 'socket allowed'"
          :tone="simulator.latches['socket-disabled'] ? 'bad' : 'ok'"
        />
        <span class="text-xs text-stone-600">
          a latch, not a drop: the screen opens no socket while it is on, so its presence entry goes
          stale and expires. Push is still the chosen transport.
        </span>
      </li>

      <li class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="w-64 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white"
          @click="simulator.toggleLatched('polling-forced', 'Force Polling Transport')"
        >
          Force Polling Transport
        </button>
        <StateBadge
          :label="simulator.latches['polling-forced'] ? 'push declined' : 'push allowed'"
          :tone="simulator.latches['polling-forced'] ? 'warn' : 'ok'"
        />
        <span class="text-xs text-stone-600">
          this terminal takes the rollout's other branch without touching the fleet-wide flag, so
          the POS badge reads <strong>POLLING</strong> and updates keep arriving — a few seconds
          later. It is how both transports can be watched side by side before a percentage exists.
        </span>
      </li>
    </ul>

    <!-- What the controls did ------------------------------------------------------------------>
    <h3 class="mt-6 text-sm font-semibold text-stone-800">What the controls did</h3>
    <ol v-if="simulator.effects.length > 0" class="mt-2 space-y-1 text-sm">
      <li v-for="effect in simulator.effects" :key="`${effect.at}-${effect.control}`">
        <span class="text-xs text-stone-500 tabular-nums">{{ formatTime(effect.at) }}</span>
        <strong class="ml-2">{{ effect.control }}</strong>
        <span class="ml-2 text-stone-600">{{ effect.detail }}</span>
      </li>
    </ol>
    <p v-else class="mt-2 text-sm text-stone-600">
      Nothing pressed in this tab yet. A one-shot armed here fires on the POS screen, and this is
      where it reports back.
    </p>
  </article>
</template>
