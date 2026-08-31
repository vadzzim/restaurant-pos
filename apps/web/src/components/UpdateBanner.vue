<script setup lang="ts">
import { applyUpdate, updateReady } from '../pwa/update';

/**
 * "A new version is ready" — the prompt that replaced M17's unconditional reload (M23).
 *
 * In the header rather than over the till: a POS screen with a modal on it is a POS screen the
 * operator has to dismiss before serving anybody, and §19 is walked on these screens. The whole
 * argument for deferring the reload is in `pwa/update.ts`.
 */
</script>

<template>
  <div
    v-if="updateReady"
    class="border-b border-amber-300 bg-amber-100 text-amber-950"
    role="status"
  >
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-2 text-sm">
      <span class="flex-1">
        <strong>A new version is ready.</strong>
        This tab is still running the build it loaded — nothing is lost either way, the queue is on
        disk, but anything half typed is not.
      </span>
      <button
        type="button"
        class="min-h-9 rounded-lg bg-amber-800 px-4 font-semibold text-white"
        @click="applyUpdate()"
      >
        Reload
      </button>
    </div>
  </div>
</template>
