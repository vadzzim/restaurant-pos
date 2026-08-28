import type { KitchenTicket } from '@pos/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { fetchTickets } from '../api/client';

/** The kitchen screen reads the projection (§12.1, §16), never the `orders` aggregate. */
export const useKitchenStore = defineStore('kitchen', () => {
  const tickets = ref<KitchenTicket[]>([]);
  const loaded = ref(false);

  async function load(restaurantId: string): Promise<void> {
    tickets.value = await fetchTickets(restaurantId);
    loaded.value = true;
  }

  return { tickets, loaded, load };
});
