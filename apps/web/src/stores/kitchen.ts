import type { KitchenTicket } from '@pos/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { fetchTickets } from '../api/client';
import { refetchUntil } from '../realtime/refetch-until';

/** What the socket told us to expect, so a lagging projection can be waited out. */
export interface ExpectedTicket {
  orderId: string;
  version: number;
}

/** The kitchen screen reads the projection (§12.1, §16), never the `orders` aggregate. */
export const useKitchenStore = defineStore('kitchen', () => {
  const tickets = ref<KitchenTicket[]>([]);
  const loaded = ref(false);
  /** True when a broadcast outran the projection and the retry budget ran out (see M04.md). */
  const lagging = ref(false);

  function shows(rows: KitchenTicket[], expected: ExpectedTicket): boolean {
    return rows.some(
      (ticket) =>
        ticket.orderId === expected.orderId && ticket.sourceEventVersion >= expected.version,
    );
  }

  /**
   * `expected` is set when a socket event triggered this load. The realtime consumer and the
   * kitchen consumer read the same topic on independent groups, so the broadcast can and does
   * arrive before the projection has been written; without waiting for it, that single refresh
   * would read the old table and the ticket would never appear.
   */
  async function load(restaurantId: string, expected?: ExpectedTicket): Promise<void> {
    const outcome = await refetchUntil(
      () => fetchTickets(restaurantId),
      (rows) => expected === undefined || shows(rows, expected),
    );

    tickets.value = outcome.value;
    loaded.value = true;
    lagging.value = !outcome.converged;
  }

  return { tickets, loaded, lagging, load };
});
