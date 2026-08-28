import type {
  AddItemPayload,
  CancelPayload,
  ChangeQuantityPayload,
  ConflictReason,
  CreateOrderPayload,
  MutationRequest,
  MutationResponse,
  MutationType,
  OrderSnapshot,
  PayPayload,
  PaymentMethod,
  RemoveItemPayload,
} from '@pos/contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { fetchOrder, postMutation } from '../api/client';
import { acceptsSnapshot } from '../domain/order-snapshot';
import { localStore } from '../persistence/local-store';

export interface ConflictBanner {
  reason: ConflictReason;
  clientBaseVersion: number;
  serverVersion: number;
}

/**
 * Everything that makes a mutation *the same* mutation on a retry. `orderId` belongs here as much
 * as `mutationId` does: for `CREATE_ORDER` it is the aggregate's identity, and generating a fresh
 * one is what turns a retry into a second order. `terminalId` and `restaurantId` are here so a
 * retry is self-contained — it must be re-sent as the terminal that sent it, whatever the screen
 * is showing by then.
 */
export interface MutationIdentity {
  orderId: string;
  mutationId: string;
  terminalId: string;
  restaurantId: string;
  type: MutationType;
  baseVersion: number;
  payload: MutationRequest['payload'];
}

/**
 * Whether a pending identity describes the action being attempted now. The payloads are built here
 * in a fixed key order, so comparing their serialisations is sound.
 */
export function sameMutation(
  pending: MutationIdentity | undefined,
  type: MutationType,
  orderId: string | undefined,
  baseVersion: number,
  payload: MutationRequest['payload'],
): boolean {
  if (pending === undefined || pending.type !== type || pending.baseVersion !== baseVersion) {
    return false;
  }

  if (orderId !== undefined && pending.orderId !== orderId) {
    return false;
  }

  return JSON.stringify(pending.payload) === JSON.stringify(payload);
}

export const useOrderStore = defineStore('order', () => {
  const order = ref<OrderSnapshot | undefined>();
  const conflict = ref<ConflictBanner | undefined>();
  const lastError = ref<string | undefined>();
  /**
   * A failed canonical read, kept apart from `lastError`. A refresh that could not be made and a
   * mutation that was refused are different facts with different lifetimes: one is cleared by the
   * next successful read of the same order, the other by the next answered mutation. Sharing one
   * field made a stale read failure outlive its cause and sit under an unrelated screen.
   */
  const readError = ref<string | undefined>();
  const inFlight = ref(0);
  /**
   * Mutations whose fate is unknown: they left this client and no answer came back. Each is kept so
   * the operator's next attempt reuses the same `mutationId` and `orderId` and is resolved
   * idempotently by §9, instead of being sent as a brand-new mutation. M8 replaces this with the
   * durable queue; the reasoning is the same, the storage is not.
   *
   * **Keyed by terminal, because a pending mutation belongs to the device that sent it.** This
   * store is a singleton and the terminal is a route parameter, so one browser tab can walk from
   * `/pos/pos-1` to `/pos/pos-3` — a different restaurant. A single shared slot would let POS-3
   * retry POS-1's mutation and adopt another tenant's order onto its screen, whereupon every
   * command it sent would be rejected as cross-tenant. The server would be right and the screen
   * would be lying.
   */
  const pendingByTerminal = ref(new Map<string, MutationIdentity>());
  /** Which terminal's screen is on show; set by the view from the route. */
  const activeTerminalId = ref<string | undefined>();

  const version = computed(() => order.value?.version ?? 0);
  const syncing = computed(() => inFlight.value > 0);
  /** The unresolved mutation of the terminal currently on screen, if it has one. */
  const pending = computed(() =>
    activeTerminalId.value === undefined
      ? undefined
      : pendingByTerminal.value.get(activeTerminalId.value),
  );
  /**
   * One slot per terminal means one unresolved mutation at a time. While it is occupied that
   * terminal takes no new commands: sending one would overwrite the only `mutationId` that can
   * still resolve the first, and its outcome would become permanently unknowable. This is the same
   * shape as §14.1's halt-on-conflict — the queue for this aggregate stops until a human decides —
   * and M8 gives it the durable, per-aggregate form.
   */
  const blocked = computed(() => pending.value !== undefined);

  /**
   * Which screen currently owns this store.
   *
   * The terminal id alone cannot serve as the claim, because it survives the screen: a view that
   * unmounts leaves `activeTerminalId` pointing at the terminal it was rendering, so a hydration
   * still reading from disk would find its check passing against a screen that no longer exists.
   * Every claim and every release therefore bumps a generation, the same shape `connection.start`
   * and `connection.stop` already use.
   */
  let terminalGeneration = 0;

  /** The view announces which terminal it is rendering; nothing else may resolve that one. */
  function useTerminal(terminalId: string): void {
    terminalGeneration += 1;
    activeTerminalId.value = terminalId;
  }

  /**
   * The view is going away. Called from `onBeforeUnmount`, and before rebuilding on a terminal
   * switch — anything still in flight for the old screen must not be able to write into the new
   * one, or into no screen at all.
   */
  function releaseTerminal(): void {
    terminalGeneration += 1;
    activeTerminalId.value = undefined;
  }

  /**
   * Install a canonical snapshot on screen. **Memory only, deliberately.**
   *
   * Caching is not a side effect of displaying: the cache is keyed by the terminal that *asked*
   * the server, and only the caller knows which terminal that was. `send` can answer for a
   * terminal whose screen has already moved on, and `hydrate` installs a snapshot that came off
   * the disk in the first place. Persisting here would key all three by whatever screen happens to
   * be showing, and would put the write in the wrong order relative to deleting the pending row —
   * which is exactly the crash window the review found.
   */
  function adopt(snapshot: OrderSnapshot): void {
    if (acceptsSnapshot(order.value, snapshot)) {
      order.value = snapshot;
    }
  }

  /**
   * Restore this terminal's state after a reload, then read the canonical snapshot.
   *
   * **Hydration is a second writer for state that already has an owner**, and every one of those
   * rules has to hold across a reload as well as across a screen:
   *
   * - the snapshot goes through `adopt`, so the monotonic-version rule still refuses a cached
   *   snapshot older than one a refetch has already installed;
   * - it also checks that no order is held at all. `adopt` accepts a snapshot for a *different*
   *   order unconditionally — that is how a `CREATE_ORDER` response installs a new aggregate — so
   *   without this check a slow read of the cached order would silently replace the order the
   *   operator created while it was in flight. This is `refetch`'s guard restated for a second
   *   slow reader; `adopt` cannot tell its callers apart;
   * - the pending slot is filled only if it is empty. A mutation sent since hydration began is the
   *   more recent intent and must not be overwritten by a record of an older one;
   * - and nothing is written at all if the screen has moved to another terminal — or has gone
   *   away entirely, which the generation is what detects.
   *
   * **The restored `mutationId` is the one that was stored.** Minting a fresh one would turn the
   * operator's Retry into a second mutation at a stale `baseVersion`: a duplicate order, or a
   * conflict reported over an operation that in fact succeeded. Nothing downstream could catch
   * it — the identity is the only thing §9 has to work with.
   *
   * **It ends with a canonical read, and that is part of hydration rather than of the view.** The
   * cache is never authoritative (ADR 013), and a caller that forgets to refresh it leaves a
   * stale order on screen indefinitely. Making it one operation is what guarantees the refresh
   * happens on every transport — the socket's `onConnected` refetch does not run at all when
   * `realtime.websocket_push` is off or `GET /api/config` fails.
   */
  async function hydrate(terminalId: string): Promise<void> {
    const mine = terminalGeneration;
    const restored = await localStore.readTerminalState(terminalId);

    if (mine !== terminalGeneration || activeTerminalId.value !== terminalId) {
      return;
    }

    const held = restored.pending;
    if (held !== undefined && !pendingByTerminal.value.has(terminalId)) {
      pendingByTerminal.value.set(terminalId, {
        orderId: held.orderId,
        mutationId: held.mutationId,
        terminalId: held.terminalId,
        restaurantId: held.restaurantId,
        type: held.type,
        baseVersion: held.baseVersion,
        payload: held.payload,
      });
    }

    if (restored.order !== undefined && order.value === undefined) {
      // No write back: this snapshot came off the disk, and the pointer that found it is already
      // there. `adopt` stays the installer so the version rule still applies.
      adopt(restored.order);
    }

    await refetch();
    await localStore.pruneOrders();
  }

  /**
   * The canonical read (§13). Every socket message that survives the gate ends here rather than
   * being applied as a payload: the server owns the arithmetic, the browser only displays it.
   */
  async function refetch(): Promise<void> {
    const id = order.value?.id;
    if (id === undefined) {
      return;
    }

    // A socket event triggers this without awaiting it, so a rejection here would surface as an
    // unhandled promise rejection and nowhere else. A failed refresh only means the screen stays
    // as it is until the next event or reconnect — worth saying, not worth throwing.
    let snapshot: OrderSnapshot | undefined;
    try {
      snapshot = await fetchOrder(id);
    } catch (error) {
      // Reported only if the screen is still asking this question. The success path below has to
      // check that, and a failure is no different: an error about the order the operator has
      // already left belongs to nobody, least of all to whatever replaced it.
      if (order.value?.id === id) {
        readError.value = error instanceof Error ? error.message : 'The order could not be read.';
      }
      return;
    }

    // The screen may have moved to another order — or to none — while this was in flight. Without
    // this check a slow read of the previous order would reinstall it over its successor, because
    // `adopt` cannot see that this snapshot answers a question nobody is asking any more.
    if (snapshot !== undefined && order.value?.id === id) {
      readError.value = undefined;
      adopt(snapshot);

      // Cached against the terminal on screen, because this read was made on its behalf.
      const terminalId = activeTerminalId.value;
      if (terminalId !== undefined) {
        await localStore.saveOrder(terminalId, snapshot);
      }
    }
  }

  /**
   * The order a response carries, if it carries one. `MUTATION_ID_REUSED` and `REJECTED` carry
   * only a reason — there is nothing to cache, and nothing that needs caching: the server has
   * refused the mutation outright, so its fate is known without a snapshot.
   */
  function canonicalOrderIn(response: MutationResponse): OrderSnapshot | undefined {
    switch (response.status) {
      case 'APPLIED':
      case 'ALREADY_APPLIED':
        return response.order;
      case 'CONFLICT':
        return response.canonicalOrder;
      default:
        return undefined;
    }
  }

  async function send(identity: MutationIdentity): Promise<MutationResponse | undefined> {
    // A mutation is only ever resolved from the terminal that sent it. Otherwise the response —
    // another restaurant's order — would land on this screen.
    if (identity.terminalId !== activeTerminalId.value) {
      lastError.value = `That mutation belongs to ${identity.terminalId}. Resolve it from that terminal.`;
      return undefined;
    }

    const held = pendingByTerminal.value.get(identity.terminalId);
    if (held !== undefined && held.mutationId !== identity.mutationId) {
      lastError.value =
        'A mutation from this terminal has no answer yet. Retry or discard it before sending another.';
      return undefined;
    }

    const request: MutationRequest = {
      mutationId: identity.mutationId,
      terminalId: identity.terminalId,
      restaurantId: identity.restaurantId,
      baseVersion: identity.baseVersion,
      type: identity.type,
      payload: identity.payload,
    };

    inFlight.value += 1;
    pendingByTerminal.value.set(identity.terminalId, identity);

    // §14's ordering: the intent is durable *before* it is attempted. A row written after the
    // request would be missing for precisely the window this milestone exists to cover — the one
    // where the tab dies with no answer. `SYNCING` is what a row is while a request for it is in
    // the air; the catch below puts it back to `PENDING` when no answer arrives.
    await localStore.savePending({ ...identity, status: 'SYNCING' });

    try {
      const response = await postMutation(identity.orderId, request);

      // The server answered, so this mutation's fate is known however it turned out. Only a
      // request that never produced an answer stays pending.
      pendingByTerminal.value.delete(identity.terminalId);

      // **The answer is cached before the identity that could recover it is dropped.** These two
      // writes are not atomic, and the tab can die between them. Deleting first leaves the one
      // state that loses money: for `CREATE_ORDER`, the row is gone, the snapshot never arrived,
      // and `createOrder` already cleared the pointer before sending — so the reload shows an
      // empty till and the operator rings the order up a second time. In the other order the worst
      // case is a row that outlived its answer, which Retry resolves as `ALREADY_APPLIED`.
      //
      // Keyed by the terminal that *sent* it, not by whatever screen is showing: the cache belongs
      // to the device that asked the question.
      const canonical = canonicalOrderIn(response);
      if (canonical !== undefined) {
        await localStore.saveOrder(identity.terminalId, canonical);
      }
      await localStore.deletePending(identity.mutationId);

      // The screen may have moved to another terminal while this was in flight; the answer is
      // still recorded above, but it must not be painted onto a terminal that did not ask.
      if (identity.terminalId !== activeTerminalId.value) {
        return response;
      }

      switch (response.status) {
        case 'APPLIED':
        case 'ALREADY_APPLIED':
          conflict.value = undefined;
          lastError.value = undefined;
          adopt(response.order);
          break;
        case 'CONFLICT':
          // The server's version of the truth replaces ours immediately; resolving the *queue* is
          // M8's problem, and this milestone has no queue to halt.
          conflict.value = {
            reason: response.reason,
            clientBaseVersion: response.clientBaseVersion,
            serverVersion: response.serverVersion,
          };
          adopt(response.canonicalOrder);
          break;
        default:
          lastError.value = response.reason;
      }

      return response;
    } catch (error) {
      // `pending` deliberately survives, and so does the row — back to `PENDING`, which is what
      // an intent nobody is currently attempting looks like. The mutation may well have been
      // applied; the id that can still settle it is the one thing that must not be lost.
      await localStore.setPendingStatus(identity.mutationId, 'PENDING');
      lastError.value = error instanceof Error ? error.message : 'The mutation failed.';
      return undefined;
    } finally {
      inFlight.value -= 1;
    }
  }

  /**
   * Retrying with the same `mutationId` turns a lost response into `ALREADY_APPLIED` (§9). With a
   * fresh one the retry is a new mutation at a stale `baseVersion`, so it comes back as a conflict
   * over an operation that in fact succeeded — technically safe, and a lie to the operator.
   */
  function identityFor(
    type: MutationType,
    orderId: string,
    terminalId: string,
    restaurantId: string,
    baseVersion: number,
    payload: MutationRequest['payload'],
  ): MutationIdentity {
    const held = pendingByTerminal.value.get(terminalId);
    if (sameMutation(held, type, orderId, baseVersion, payload)) {
      return held as MutationIdentity;
    }

    return {
      orderId,
      mutationId: crypto.randomUUID(),
      terminalId,
      restaurantId,
      type,
      baseVersion,
      payload,
    };
  }

  async function createOrder(
    terminalId: string,
    restaurantId: string,
    tableNumber: string,
  ): Promise<void> {
    const payload: CreateOrderPayload = { tableNumber };
    const held = pendingByTerminal.value.get(terminalId);
    const retrying = sameMutation(held, 'CREATE_ORDER', undefined, 0, payload);

    // Reusing the id is the whole point (§5). A lost response plus a fresh `orderId` would create
    // a second order for the same table — the one write in the system that no version check and
    // no `mutationId` could catch afterwards.
    const identity: MutationIdentity = retrying
      ? (held as MutationIdentity)
      : {
          orderId: crypto.randomUUID(),
          mutationId: crypto.randomUUID(),
          terminalId,
          restaurantId,
          type: 'CREATE_ORDER',
          baseVersion: 0,
          payload,
        };

    if (!retrying) {
      order.value = undefined;
      conflict.value = undefined;
      // The terminal has left the previous order. Without this the pointer would still name it if
      // the creation never got an answer, and the reload would restore the order the operator had
      // already walked away from.
      await localStore.clearCurrentOrder(terminalId);
    }

    await send(identity);
  }

  async function addItem(
    terminalId: string,
    restaurantId: string,
    productId: string,
    quantity = 1,
  ): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    const payload: AddItemPayload = { productId, quantity };
    await send(
      identityFor('ADD_ITEM', current.id, terminalId, restaurantId, current.version, payload),
    );
  }

  async function removeItem(
    terminalId: string,
    restaurantId: string,
    productId: string,
  ): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    const payload: RemoveItemPayload = { productId };
    await send(
      identityFor('REMOVE_ITEM', current.id, terminalId, restaurantId, current.version, payload),
    );
  }

  /**
   * The absolute quantity, not a delta. A delta sent twice after a lost response would apply
   * twice if the retry were ever given a fresh `mutationId`; an absolute value cannot, and the
   * operator's intent — "make it three" — is what the screen actually knows.
   */
  async function changeQuantity(
    terminalId: string,
    restaurantId: string,
    productId: string,
    quantity: number,
  ): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    // Zero is a removal and has its own mutation type; the API refuses it on this one.
    if (quantity < 1) {
      await removeItem(terminalId, restaurantId, productId);
      return;
    }

    const payload: ChangeQuantityPayload = { productId, quantity };
    await send(
      identityFor(
        'CHANGE_QUANTITY',
        current.id,
        terminalId,
        restaurantId,
        current.version,
        payload,
      ),
    );
  }

  async function sendToKitchen(terminalId: string, restaurantId: string): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    await send(
      identityFor('SEND_TO_KITCHEN', current.id, terminalId, restaurantId, current.version, {}),
    );
  }

  /** No amount is sent: the server pays the order's own canonical total (§8). */
  async function pay(
    terminalId: string,
    restaurantId: string,
    method: PaymentMethod,
  ): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    const payload: PayPayload = { method };
    await send(identityFor('PAY', current.id, terminalId, restaurantId, current.version, payload));
  }

  async function cancel(terminalId: string, restaurantId: string, reason?: string): Promise<void> {
    const current = order.value;
    if (current === undefined) {
      return;
    }

    const payload: CancelPayload = reason === undefined ? {} : { reason };
    await send(
      identityFor('CANCEL', current.id, terminalId, restaurantId, current.version, payload),
    );
  }

  /** Re-send the mutation whose answer never arrived, unchanged. */
  async function retryPending(): Promise<void> {
    const identity = pending.value;
    if (identity !== undefined) {
      await send(identity);
    }
  }

  /**
   * Give up on an unresolved mutation. It may still have been applied on the server — the operator
   * is asserting they will live with either outcome, which is why this is a deliberate action and
   * never something a screen does on their behalf.
   */
  async function discardPending(): Promise<void> {
    const terminalId = activeTerminalId.value;
    if (terminalId !== undefined) {
      const held = pendingByTerminal.value.get(terminalId);
      pendingByTerminal.value.delete(terminalId);
      if (held !== undefined) {
        // Durable too: a discard that only cleared memory would be undone by the next reload, and
        // the operator would be asked the same unanswerable question again.
        await localStore.deletePending(held.mutationId);
      }
    }
    lastError.value = undefined;
  }

  /**
   * Start over on this screen. `pending` deliberately survives: pressing "New order" is not an
   * answer to "did that mutation apply?", and dropping the identity here would make it unknowable.
   */
  async function clear(): Promise<void> {
    order.value = undefined;
    conflict.value = undefined;
    lastError.value = undefined;
    readError.value = undefined;

    // The pointer goes; the cached snapshot and any pending row stay. Only the pointer was ever
    // about this screen — `pruneOrders` collects the snapshot once nothing refers to it any more.
    const terminalId = activeTerminalId.value;
    if (terminalId !== undefined) {
      await localStore.clearCurrentOrder(terminalId);
    }
  }

  return {
    order,
    conflict,
    lastError,
    readError,
    pending,
    blocked,
    useTerminal,
    releaseTerminal,
    hydrate,
    version,
    syncing,
    adopt,
    refetch,
    createOrder,
    addItem,
    removeItem,
    changeQuantity,
    sendToKitchen,
    pay,
    cancel,
    retryPending,
    discardPending,
    clear,
  };
});
