import type {
  ConflictReason,
  DomainEvent,
  KitchenTicket,
  KitchenTicketState,
} from '@pos/contracts';
import { KITCHEN_TERMINAL_ID } from '@pos/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { fetchTickets, postKitchenCommand } from '../api/client';
import { createCoalescingLoader } from '../realtime/coalescing-loader';

/** What the socket told us to expect, so a lagging projection can be waited out. */
export interface ExpectedTicket {
  orderId: string;
  version: number;
}

export type KitchenCommand = 'preparing' | 'ready';

/**
 * What a socket event entitles the screen to demand of the projection before it gives up waiting.
 *
 * **Only `OrderSentToKitchen` can create a ticket.** Every other kitchen event can merely advance
 * one that already exists — and `OrderCancelled` is routinely broadcast for an order the kitchen
 * never saw, because `CANCEL` is valid on an `OPEN` order and the projection deliberately records
 * that event without building anything (`recorded`, not `applied`). Expecting a ticket for such a
 * cancellation spends the whole retry budget on a row that is never going to be written and ends
 * in a `PROJECTION LAG` banner reporting a fault that does not exist.
 *
 * So: expect a ticket when the event creates one, or when this screen already holds one for that
 * order. Otherwise refresh and believe whatever comes back.
 */
export function expectationFor(
  event: DomainEvent,
  held: readonly KitchenTicket[],
): ExpectedTicket | undefined {
  const expected: ExpectedTicket = { orderId: event.aggregateId, version: event.version };

  if (event.eventType === 'OrderSentToKitchen') {
    return expected;
  }

  return held.some((ticket) => ticket.orderId === event.aggregateId) ? expected : undefined;
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

/**
 * The one command a ticket in this state can accept. The kitchen screen offers nothing else, which
 * keeps the common case one tap — but it is a convenience, not a rule: `decide()` is what actually
 * refuses an out-of-order transition, and it refuses it for every client, not just this one.
 */
export function nextCommand(state: KitchenTicketState): KitchenCommand | undefined {
  if (state === 'SENT_TO_KITCHEN') {
    return 'preparing';
  }
  return state === 'PREPARING' ? 'ready' : undefined;
}

/**
 * A kitchen command whose answer never came back, kept so the retry reuses the same `mutationId`
 * and is resolved by §9 as `ALREADY_APPLIED` rather than sent as a second command.
 *
 * **Keyed by order, which is the aggregate** — the granularity §14.1 halts at, and the one M8
 * generalises. One stuck ticket must not stop the rest of the pass: a kitchen with twelve orders
 * on the rail cannot go blind because one response was lost.
 */
export interface KitchenCommandIdentity {
  orderId: string;
  restaurantId: string;
  command: KitchenCommand;
  mutationId: string;
  baseVersion: number;
}

/** The kitchen screen reads the projection (§12.1, §16), never the `orders` aggregate. */
export const useKitchenStore = defineStore('kitchen', () => {
  const tickets = ref<KitchenTicket[]>([]);
  const loaded = ref(false);
  /** True when a broadcast outran the projection and the retry budget ran out (see M04.md). */
  const lagging = ref(false);
  /** Set when a whole round of reads failed, so the screen does not look merely quiet. */
  const loadError = ref<string | undefined>();
  const pendingByOrder = ref(new Map<string, KitchenCommandIdentity>());
  /** Why the server last refused a command for this ticket, shown on the card itself. */
  const conflictByOrder = ref(new Map<string, ConflictReason>());
  const commandError = ref<string | undefined>();

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

  /**
   * Send a kitchen transition as a real mutation (§5).
   *
   * The `baseVersion` is the ticket's `source_event_version` — the order version the event this
   * ticket was built from carried. The projection is eventually consistent, so that value can be
   * behind, and then the server answers `409`. **That is the designed outcome, not a defect**: the
   * screen refetches, the ticket shows what actually happened, and the operator presses again.
   * §21.10 is the same race between two displays. See ADR 012.
   */
  async function command(orderId: string, next: KitchenCommand): Promise<void> {
    const ticket = tickets.value.find((candidate) => candidate.orderId === orderId);
    if (ticket === undefined) {
      return;
    }

    const held = pendingByOrder.value.get(orderId);
    if (held !== undefined && held.command !== next) {
      commandError.value =
        'This ticket has a command with no answer yet. Retry or discard it before sending another.';
      return;
    }

    await dispatch(
      held ?? {
        orderId,
        restaurantId: ticket.restaurantId,
        command: next,
        mutationId: crypto.randomUUID(),
        baseVersion: ticket.sourceEventVersion,
      },
    );
  }

  /** Re-send the command whose answer never arrived, unchanged (§9). */
  async function retry(orderId: string): Promise<void> {
    const identity = pendingByOrder.value.get(orderId);
    if (identity !== undefined) {
      await dispatch(identity);
    }
  }

  /**
   * Give up on an unresolved command. It may still have been applied — the operator is accepting
   * that, which is why it is a deliberate action. The projection is the tiebreaker: whatever the
   * next read shows is what happened.
   */
  function discard(orderId: string): void {
    pendingByOrder.value.delete(orderId);
    commandError.value = undefined;
  }

  async function dispatch(identity: KitchenCommandIdentity): Promise<void> {
    pendingByOrder.value.set(identity.orderId, identity);

    let response;
    try {
      response = await postKitchenCommand(identity.orderId, identity.command, {
        mutationId: identity.mutationId,
        terminalId: KITCHEN_TERMINAL_ID,
        restaurantId: identity.restaurantId,
        baseVersion: identity.baseVersion,
      });
    } catch (error) {
      // The identity deliberately survives: the command may well have been applied.
      commandError.value = error instanceof Error ? error.message : 'The command failed.';
      return;
    }

    // The server answered, so this command's fate is known however it turned out.
    pendingByOrder.value.delete(identity.orderId);
    commandError.value = undefined;

    switch (response.status) {
      case 'APPLIED':
      case 'ALREADY_APPLIED':
        conflictByOrder.value.delete(identity.orderId);
        await load(restaurantId, { orderId: identity.orderId, version: response.serverVersion });
        break;
      case 'CONFLICT':
        conflictByOrder.value.set(identity.orderId, response.reason);
        // No expectation: the projection owes us nothing after a refusal, and asking it to catch
        // up to a version that was never written would burn the whole retry budget.
        await load(restaurantId);
        break;
      default:
        commandError.value = response.reason;
    }
  }

  return {
    tickets,
    loaded,
    lagging,
    loadError,
    pendingByOrder,
    conflictByOrder,
    commandError,
    load,
    command,
    retry,
    discard,
  };
});
