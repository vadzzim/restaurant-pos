import type { KitchenTicket } from '@pos/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { fetchTickets } from '../api/client';
import { createCoalescingLoader } from '../realtime/coalescing-loader';

/** What the socket told us to expect, so a lagging projection can be waited out. */
export interface ExpectedTicket {
  orderId: string;
  version: number;
}

/** Whether one read of the projection accounts for every expectation of this round. */
export function ticketsSatisfy(rows: KitchenTicket[], expectations: ExpectedTicket[]): boolean {
  return expectations.every((expected) =>
    rows.some(
      (ticket) =>
        ticket.orderId === expected.orderId && ticket.sourceEventVersion >= expected.version,
    ),
  );
}

/** The kitchen screen reads the projection (§12.1, §16), never the `orders` aggregate. */
export const useKitchenStore = defineStore('kitchen', () => {
  const tickets = ref<KitchenTicket[]>([]);
  const loaded = ref(false);
  /** True when a broadcast outran the projection and the retry budget ran out (see M04.md). */
  const lagging = ref(false);
  /** Set when a whole round of reads failed, so the screen does not look merely quiet. */
  const loadError = ref<string | undefined>();

  let restaurantId = '';

  /**
   * Reads are coalesced rather than run in parallel: this list is replaced wholesale, so two
   * overlapping loads could land out of order and take a visible ticket back off the screen.
   */
  const loader = createCoalescingLoader<ExpectedTicket, KitchenTicket[]>({
    read: () => fetchTickets(restaurantId),
    satisfied: ticketsSatisfy,
    apply: (rows, converged) => {
      tickets.value = rows;
      loaded.value = true;
      lagging.value = !converged;
      loadError.value = undefined;
    },
    onError: (error) => {
      loadError.value =
        error instanceof Error ? error.message : 'The kitchen tickets could not be read.';
    },
  });

  /**
   * `expected` is set when a socket event triggered this load. The realtime consumer and the
   * kitchen consumer read the same topic on independent groups, so the broadcast can and does
   * arrive before the projection has been written; without waiting for it, that single refresh
   * would read the old table and the ticket would never appear.
   */
  async function load(forRestaurantId: string, expected?: ExpectedTicket): Promise<void> {
    restaurantId = forRestaurantId;
    await loader.run(expected);
  }

  return { tickets, loaded, lagging, loadError, load };
});
