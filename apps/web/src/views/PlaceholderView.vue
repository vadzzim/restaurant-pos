<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const label = computed(() => {
  if (route.name === 'pos') {
    return `POS / ${String(route.params.terminalId)}`;
  }

  return String(route.name ?? 'Restaurant POS').toUpperCase();
});
</script>

<template>
  <section>
    <p class="mb-2 text-sm font-medium text-emerald-800">M1 skeleton</p>
    <h1 class="text-3xl font-semibold">{{ label }}</h1>
  </section>
</template>
