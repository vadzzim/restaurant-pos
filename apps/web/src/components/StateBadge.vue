<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{ label: string; tone?: 'ok' | 'warn' | 'bad' | 'neutral' }>(),
  { tone: 'neutral' },
);

/** §16 asks for technical state to be obvious at a glance, not for visual design. */
const classes = computed(
  () =>
    ({
      ok: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
      warn: 'bg-amber-100 text-amber-900 ring-amber-300',
      bad: 'bg-rose-100 text-rose-900 ring-rose-300',
      neutral: 'bg-stone-200 text-stone-800 ring-stone-300',
    })[props.tone],
);
</script>

<template>
  <span
    class="inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold tracking-wide uppercase ring-1 ring-inset"
    :class="classes"
  >
    {{ label }}
  </span>
</template>
