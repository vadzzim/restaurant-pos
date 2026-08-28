import type {
  ConflictReason,
  DomainEvent,
  KitchenTicket,
  KitchenTicketState,
  MutationType,
} from '@pos/contracts';
import { KITCHEN_TERMINAL_ID } from '@pos/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { fetchTickets, postKitchenCommand } from '../api/client';
import { localStore } from '../persistence/local-store';
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
 * **A cancellation is the only kitchen event that can concern an order with no ticket and never
 * will.** `CANCEL` is valid on an `OPEN` order, and the projection then records the event without
 * building anything (`recorded`, not `applied`); expecting a ticket for that spends the whole
 * retry budget on a row nobody is going to write and ends in a `PROJECTION LAG` banner reporting a
 * fault that does not exist.
 *
 * Every other kitchen event necessarily concerns a ticket that exists — `OrderSentToKitchen`
 * creates one, `START_PREPARING` requires `SENT_TO_KITCHEN` and `MARK_READY` requires `PREPARING`.
 * So if the screen has not got that ticket yet, the projection is behind, which is precisely the
 * case the wait exists for. **Skipping the wait because the ticket is not here yet would skip it
 * exactly when it is needed** — and the event gate has already spent this event's only hint, so
 * the rail would sit in the previous column until another event or a reload.
 *
 * The residue is narrow and named: a cancellation of an order that *was* sent to the kitchen, but
 * whose ticket this screen has not seen yet, gets no wait either. Closing that would mean telling
 * the client, in the event, whether the order had ever reached the kitchen — a display concern
 * pushed into a domain payload, for a case bounded by the next event or a reload.
 */
export function expectationFor(
  event: DomainEvent,
  held: readonly KitchenTicket[],
): ExpectedTicket | undefined {
  const expected: ExpectedTicket = { orderId: event.aggregateId, version: event.version };

  if (event.eventType !== 'OrderCancelled') {
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

/**
 * A kitchen command is a real mutation (§5), and it is stored as one.
 *
 * The kitchen and the POS share a single `pendingMutations` table because M8 syncs a single queue:
 * two tables would mean two sync engines and two places for §14.1's halt to be implemented. So the
 * rail's `'preparing' | 'ready'` — a label for a button — is translated to and from the mutation
 * type at the storage boundary and nowhere else.
 */
const MUTATION_TYPE_BY_COMMAND = {
  preparing: 'START_PREPARING',
  ready: 'MARK_READY',
} as const satisfies Record<KitchenCommand, MutationType>;

export const mutationTypeFor = (command: KitchenCommand): MutationType =>
  MUTATION_TYPE_BY_COMMAND[command];

export function commandFor(type: MutationType): KitchenCommand | undefined {
  if (type === 'START_PREPARING') {
    return 'preparing';
  }
  return type === 'MARK_READY' ? 'ready' : undefined;
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
  async function discard(orderId: string): Promise<void> {
    const held = pendingByOrder.value.get(orderId);
    pendingByOrder.value.delete(orderId);
    commandError.value = undefined;

    if (held !== undefined) {
      await localStore.deletePending(held.mutationId);
    }
  }

  /**
   * Restore this rail's unresolved commands after a reload.
   *
   * **Filtered by restaurant, and that filter is load-bearing.** Every kitchen row carries the
   * same `terminalId` — there is one display id and every restaurant shares it — so reading by
   * terminal alone would put restaurant A's commands on B's rail. Retrying one would then send a
   * cross-tenant mutation that the server would rightly refuse, while the screen insisted the
   * ticket was its own.
   *
   * Like the POS's `hydrate`, this is a second writer: it re-checks its claim after the await, and
   * it fills only slots that are still empty — a command sent since hydration began is the more
   * recent intent.
   */
  async function hydrateCommands(forRestaurantId: string): Promise<void> {
    restaurantId = forRestaurantId;

    const rows = await localStore.readPendingForTerminalInRestaurant(
      KITCHEN_TERMINAL_ID,
      forRestaurantId,
    );

    if (restaurantId !== forRestaurantId) {
      return;
    }

    for (const row of rows) {
      const command = commandFor(row.type);
      // A row for some other mutation type is not this screen's to resolve. It cannot happen
      // today — only the two transitions are stored under the kitchen terminal — and dropping it
      // silently is still right: the POS's queue owns everything else.
      if (command === undefined || pendingByOrder.value.has(row.orderId)) {
        continue;
      }

      // The stored `mutationId` and `baseVersion`, unchanged. A fresh id here would send a second
      // command at a stale version instead of the §9 repeat that resolves the first.
      pendingByOrder.value.set(row.orderId, {
        orderId: row.orderId,
        restaurantId: row.restaurantId,
        command,
        mutationId: row.mutationId,
        baseVersion: row.baseVersion,
      });
    }
  }

  async function dispatch(identity: KitchenCommandIdentity): Promise<void> {
    pendingByOrder.value.set(identity.orderId, identity);

    // Durable before it is attempted, for the same reason as the POS: the window this covers is
    // the one where the tab dies with no answer.
    await localStore.savePending({
      mutationId: identity.mutationId,
      restaurantId: identity.restaurantId,
      terminalId: KITCHEN_TERMINAL_ID,
      orderId: identity.orderId,
      baseVersion: identity.baseVersion,
      type: mutationTypeFor(identity.command),
      payload: {},
      status: 'SYNCING',
    });

    let response;
    try {
      response = await postKitchenCommand(identity.orderId, identity.command, {
        mutationId: identity.mutationId,
        terminalId: KITCHEN_TERMINAL_ID,
        restaurantId: identity.restaurantId,
        baseVersion: identity.baseVersion,
      });
    } catch (error) {
      // The identity deliberately survives, in memory and on disk: the command may well have been
      // applied, and the id is the only thing that can still settle it under §9.
      await localStore.setPendingStatus(identity.mutationId, 'PENDING');
      commandError.value = error instanceof Error ? error.message : 'The command failed.';
      return;
    }

    // The server answered, so this command's fate is known however it turned out.
    pendingByOrder.value.delete(identity.orderId);
    await localStore.deletePending(identity.mutationId);
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
    hydrateCommands,
    command,
    retry,
    discard,
  };
});
