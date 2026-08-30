<script setup lang="ts">
import type { FeatureFlagKey } from '@pos/contracts';
import { onBeforeUnmount, onMounted, reactive } from 'vue';

import { formatTime } from '../domain/debug-view';
import { useFlagStore } from '../stores/flags';
import StateBadge from './StateBadge.vue';

/**
 * §15's rollout, on the page that runs it.
 *
 * The percentage alone would leave the operator guessing which restaurant falls which way, so each
 * flag shows the resolved answer *and* the bucket behind it. That is what makes the demo repeatable:
 * with the seeded ids, `demo-restaurant` sits at 1 and `second-restaurant` at 24, so anything
 * between 2 and 24 puts POS-1 on push and POS-3 on polling, side by side.
 *
 * The toggle takes effect fleet-wide with no restart; an already-open client picks it up on its own
 * 15-second config poll, which is the one path §15 allows — a socket control event cannot carry
 * "the socket is off".
 */
const flags = useFlagStore();

/** The percentage field is local until it is submitted, so typing `4` in `40` is not a rollout. */
const drafts = reactive<Record<string, number>>({});

onMounted(() => {
  flags.start();
});

onBeforeUnmount(() => {
  flags.stop();
});

const draftFor = (key: FeatureFlagKey, current: number): number => drafts[key] ?? current;

const setDraft = (key: FeatureFlagKey, value: string): void => {
  drafts[key] = Number(value);
};

async function applyRollout(key: FeatureFlagKey, current: number): Promise<void> {
  await flags.update(key, { rolloutPercent: draftFor(key, current) });
  // Back to following the server: the response is authoritative and the field should show it.
  delete drafts[key];
}
</script>

<template>
  <article class="rounded border border-stone-300 bg-white p-4">
    <h2 class="mb-1 text-lg font-semibold">Feature flags</h2>
    <p class="mb-3 text-sm text-stone-600">
      §15's safe rollout. <strong>enabled</strong> is the master switch and
      <strong>rollout</strong> is the share of restaurants that get it, by a stable hash of the
      restaurant id — so a restaurant does not change transport between two polls. Both branches of
      <code>realtime.websocket_push</code> are complete implementations: turning it off costs
      latency, not correctness. An open terminal switches within 15 seconds, with no reload.
    </p>

    <p v-if="flags.error" class="mb-3 text-sm text-rose-700">{{ flags.error }}</p>

    <ul class="space-y-4">
      <li
        v-for="flag in flags.flags"
        :key="flag.key"
        class="border-b border-stone-200 pb-3 last:border-0"
      >
        <div class="flex flex-wrap items-center gap-3">
          <code class="w-64 text-sm font-semibold">{{ flag.key }}</code>
          <button
            type="button"
            class="w-40 rounded bg-stone-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            :disabled="flags.busy === flag.key"
            @click="flags.update(flag.key, { enabled: !flag.enabled })"
          >
            {{ flag.enabled ? 'Disable' : 'Enable' }}
          </button>
          <StateBadge
            :label="flag.enabled ? 'enabled' : 'disabled'"
            :tone="flag.enabled ? 'ok' : 'bad'"
          />
          <span class="text-xs text-stone-600">changed {{ formatTime(flag.updatedAt) }}</span>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-3">
          <label class="w-64 text-sm text-stone-700" :for="`rollout-${flag.key}`">
            rollout percent
          </label>
          <input
            :id="`rollout-${flag.key}`"
            class="w-24 rounded border border-stone-300 px-2 py-1 text-sm"
            type="number"
            min="0"
            max="100"
            :value="draftFor(flag.key, flag.rolloutPercent)"
            @input="setDraft(flag.key, ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="rounded border border-stone-400 px-3 py-1 text-sm font-semibold disabled:opacity-50"
            :disabled="flags.busy === flag.key"
            @click="applyRollout(flag.key, flag.rolloutPercent)"
          >
            Apply
          </button>
          <span class="text-xs text-stone-600">
            in the rollout when <strong>bucket &lt; rollout</strong>
          </span>
        </div>

        <ul class="mt-2 space-y-1">
          <li
            v-for="entry in flag.resolved"
            :key="entry.restaurantId"
            class="flex flex-wrap items-center gap-2 text-sm"
          >
            <span class="w-64 text-stone-700">{{ entry.restaurantId }}</span>
            <StateBadge
              :label="entry.enabled ? 'push' : 'polling'"
              :tone="entry.enabled ? 'ok' : 'warn'"
            />
            <span class="text-xs text-stone-600">bucket {{ entry.bucket }}</span>
          </li>
        </ul>
      </li>

      <li v-if="flags.flags.length === 0" class="text-sm text-stone-600">No flags are defined.</li>
    </ul>
  </article>
</template>
