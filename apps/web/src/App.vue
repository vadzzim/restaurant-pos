<script setup lang="ts">
import UpdateBanner from './components/UpdateBanner.vue';
</script>

<template>
  <div class="min-h-screen bg-stone-100 text-stone-950">
    <UpdateBanner />
    <header class="border-b border-stone-300 bg-[#17201c] text-white">
      <div class="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-6 px-5">
        <strong class="text-base font-semibold">Restaurant POS</strong>
        <nav class="flex flex-wrap items-center gap-5 text-sm text-stone-200" aria-label="Primary">
          <RouterLink to="/pos/pos-1">POS</RouterLink>
          <RouterLink to="/kitchen">Kitchen</RouterLink>
          <RouterLink to="/debug">Debug</RouterLink>
          <RouterLink to="/demo">Demo</RouterLink>
        </nav>
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-5 py-10">
      <RouterView />
    </main>
  </div>
</template>
