import type { MenuItem } from '@pos/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { fetchMenu } from '../api/client';

export const useMenuStore = defineStore('menu', () => {
  const items = ref<MenuItem[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    items.value = await fetchMenu();
    loaded.value = true;
  }

  return { items, loaded, load };
});
