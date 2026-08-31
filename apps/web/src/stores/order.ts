import type {
  AddItemPayload,
  CancelPayload,
  ChangeQuantityPayload,
  ConflictReason,
  ConflictResolution,
  CreateOrderPayload,
  MutationRequest,
  MutationType,
  OrderSnapshot,
  PayPayload,
  PaymentMethod,
  RemoveItemPayload,
} from '@pos/contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { fetchOrder, postConflictResolution, postMutation } from '../api/client';
import { acceptsSnapshot } from '../domain/order-snapshot';
import { menuLookup, nextBaseVersion, projectQueue } from '../domain/project-queue';
import type { PendingMutationRecord } from '../persistence/db';
import { localStore } from '../persistence/local-store';
import { createSyncEngine, groupByOrder, isSendable } from '../sync/engine';

import { useMenuStore } from './menu';

export interface ConflictBanner {
  orderId: string;
  reason: ConflictReason;
  clientBaseVersion: number;
  serverVersion: number;
}

/**
 * Everything that makes a mutation *the same* mutation on a retry. `orderId` belongs here as much
 * as `mutationId` does: for `CREATE_ORDER` it is the aggregate's identity, and generating a fresh
 * one is what turns a retry into a second order.
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

export const useOrderStore = defineStore('order', () => {
  /**
   * The last **canonical** snapshot for the order this screen is on — the server's truth, never a
   * prediction. What the operator sees is `projected`, which folds the queue onto this.
   */
  const order = ref<OrderSnapshot | undefined>();
  /**
   * Which order this screen is on, in memory, mirroring `syncMetadata.currentOrderId`.
   *
   * It cannot be derived from `order.value?.id`: an order created while the device is offline has
   * no canonical snapshot at all, and it is precisely that order the operator is working on.
   */
  const currentOrderId = ref<string | undefined>();
  const conflict = ref<ConflictBanner | undefined>();
  const lastError = ref<string | undefined>();
  /**
   * A failed canonical read, kept apart from `lastError`. A refresh that could not be made and a
   * mutation that was refused are different facts with different lifetimes: one is cleared by the
   * next successful read of the same order, the other by the next answered mutation.
   */
  const readError = ref<string | undefined>();
  const inFlight = ref(0);
  /**
   * **The queue lives on disk; this is a mirror of it**, for the terminal on screen, in local
   * creation order.
   *
   * It is replaced wholesale after every write and never edited in place. Two copies of the truth
   * is the bug this milestone is most exposed to — the engine writes rows the screen did not ask
   * for — and a mirror that is only ever overwritten cannot drift into disagreeing with the table
   * it reflects. A stale mirror is a display bug; a divergent second copy is a lost mutation.
   */
  const queue = ref<PendingMutationRecord[]>([]);
  /** Which terminal's screen is on show; set by the view from the route. */
  const activeTerminalId = ref<string | undefined>();

  /** The queued mutations for the order on screen, in order. */
  const currentQueue = computed(() =>
    currentOrderId.value === undefined
      ? []
      : queue.value.filter((row) => row.orderId === currentOrderId.value),
  );

  /**
   * What the operator sees: the canonical snapshot with every queued mutation folded onto it.
   *
   * §14 — the UI updates optimistically and never waits for the server. Derived on read, never
   * stored: see `domain/project-queue.ts` for why that is the whole reason this milestone has no
   * optimistic-write crash window.
   */
  const projected = computed(() =>
    projectQueue(order.value, currentQueue.value, menuLookup(useMenuStore().items)),
  );

  const version = computed(() => projected.value?.version ?? 0);
  const canonicalVersion = computed(() => order.value?.version ?? 0);
  const syncing = computed(() => inFlight.value > 0);

  /** Everything this terminal has queued and not yet had answered, across all its orders. */
  const pendingCount = computed(() => queue.value.length);
  const pendingForOtherOrders = computed(() => queue.value.length - currentQueue.value.length);

  /**
   * §14.1: this aggregate is halted and waits for a human.
   *
   * Derived from the rows rather than from the in-memory banner, because the halt is durable and
   * the banner is not: after a reload the `CONFLICT` and `BLOCKED` labels are still on disk and the
   * screen must still refuse to send. It is the same predicate the engine's send gate uses, which
   * is the point — one rule, asked by both.
   */
  const halted = computed(() => currentQueue.value.length > 0 && !isSendable(currentQueue.value));
  /**
   * The conflict banner, but only when it is about the order on screen. The engine syncs every
   * order this terminal queued, so it can raise a conflict for an order the operator has left —
   * and a rose banner about an invisible order reads as a fault in the one they are looking at.
   */
  const currentConflict = computed(() =>
    conflict.value?.orderId === currentOrderId.value ? conflict.value : undefined,
  );
  const conflictedMutation = computed(() =>
    currentQueue.value.find((row) => row.status === 'CONFLICT'),
  );
  const blockedMutations = computed(() =>
    currentQueue.value.filter((row) => row.status !== 'CONFLICT'),
  );

  /**
   * Orders this terminal has queued that are halted and are **not** the one on screen.
   *
   * The halt is per aggregate and the screen is per order, so the two can come apart: the operator
   * presses "New order" while the first order's mutations are still unsent, and it is that first
   * order the server later refuses. Without this the halted group would be counted by
   * `pendingCount` and reachable by nothing — a queue nobody can resolve, which is worse than a
   * queue that stops.
   */
  const haltedElsewhere = computed(() => {
    const halts: string[] = [];
    for (const [orderId, group] of groupByOrder(queue.value)) {
      if (orderId !== currentOrderId.value && !isSendable(group)) {
        halts.push(orderId);
      }
    }
    return halts;
  });

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
   * the server, and only the caller knows which terminal that was. Persisting here would key every
   * caller by whatever screen happens to be showing, and would put the write in the wrong order
   * relative to deleting the pending row.
   */
  function adopt(snapshot: OrderSnapshot): void {
    if (acceptsSnapshot(order.value, snapshot)) {
      order.value = snapshot;
      currentOrderId.value = snapshot.id;
    }
  }

  /** Re-read the mirror from disk. Every queue write is followed by exactly this. */
  async function refreshQueue(): Promise<void> {
    const terminalId = activeTerminalId.value;
    if (terminalId === undefined) {
      queue.value = [];
      return;
    }
    queue.value = await localStore.readQueue(terminalId);
  }

  /**
   * The sync engine (§14), owned by the store because everything it writes into memory is the
   * store's. Its dependencies are the seam the §21.7 and §21.8 tests drive it through.
   */
  const engine = createSyncEngine({
    post: postMutation,
    newMutationId: () => crypto.randomUUID(),
    canonicalVersion: (orderId) => (order.value?.id === orderId ? order.value.version : 0),
    onCanonical: async (terminalId, snapshot) => {
      // Cached unconditionally: the answer is true whatever the screen is showing, and it is keyed
      // by the terminal that asked, which may no longer be the terminal on screen.
      //
      // **`cacheOrder`, not `saveOrder`.** The engine drains every order this terminal queued,
      // including ones the screen left, and an answer for one of those says nothing about which
      // order the device is on. Moving the pointer here would send the next reload to an order the
      // operator finished and strand the one they are ringing up.
      await localStore.cacheOrder(terminalId, snapshot);

      // Displayed only if this screen is the one that asked, and is still on that order.
      if (terminalId === activeTerminalId.value && currentOrderId.value === snapshot.id) {
        adopt(snapshot);
      }
    },
    onHalt: (row, cause) => {
      if (cause.kind === 'conflict') {
        conflict.value = {
          orderId: row.orderId,
          reason: cause.reason,
          clientBaseVersion: cause.clientBaseVersion,
          serverVersion: cause.serverVersion,
        };
        return;
      }
      // `MUTATION_ID_REUSED`, `REJECTED` and a permanent §17 refusal all carry a reason and no
      // snapshot. The aggregate is still halted — `halted` is derived from the rows — but there is
      // no canonical state to show beside the intent, so it is reported as an error rather than as
      // a conflict banner.
      lastError.value = cause.reason;
    },
    onQueueChanged: refreshQueue,
    onTransportError: (message) => {
      lastError.value = message;
    },
  });

  /**
   * Drain the queue. Called after every enqueue, after hydration, when the socket connects, when
   * the browser comes back online and when `Simulate Offline` is switched off.
   *
   * There is no timer: a pass that hits a transport error stops and waits for the next trigger. A
   * retry loop would make the offline demo non-deterministic and would hide the state it exists to
   * show.
   */
  async function sync(): Promise<void> {
    const terminalId = activeTerminalId.value;
    if (terminalId === undefined) {
      return;
    }

    inFlight.value += 1;
    try {
      await engine.run(terminalId);
    } finally {
      inFlight.value -= 1;
    }
  }

  /**
   * The local phase of every command, run one at a time.
   *
   * `identityFor` stamps `baseVersion` from the **projection**, so a command that computes its
   * identity before the previous one's row is in `queue` stamps a version the server has already
   * consumed — and gets `VERSION_CONFLICT`, halting the queue over a race the operator never
   * caused. Until M15 nothing enforced that: the POS screen's single `busy` flag disabled the
   * whole till for the round trip, and serialization was a side effect of the disabling.
   *
   * The ordering belongs here rather than in a screen, because it is a property of how a mutation
   * is stamped. The network attempt is deliberately **outside** this chain — that is what lets the
   * till accept taps faster than the server answers them (§14, §16).
   */
  let localPhase: Promise<unknown> = Promise.resolve();

  function serialize<T>(step: () => Promise<T>): Promise<T> {
    const next = localPhase.then(step);
    // The chain must survive a failed link: it orders writes, it does not propagate their errors.
    localPhase = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Record an intent. **This is the only way a mutation is created**, and both callers —
   * `command` and `createOrder` — run it inside a `serialize` link.
   *
   * The row is written **before** anything is attempted (§14) and the screen updates from the
   * mirror, not from a prediction written anywhere — the projection is a pure function of the
   * cache and the queue, so a crash right here loses nothing and reproduces exactly.
   *
   * Returns whether the row reached disk, or `undefined` if the mutation was refused.
   */
  async function stage(identity: MutationIdentity): Promise<boolean | undefined> {
    if (identity.terminalId !== activeTerminalId.value) {
      lastError.value = `That mutation belongs to ${identity.terminalId}.`;
      return undefined;
    }

    const stored = await localStore.savePending({ ...identity, status: 'PENDING' });
    await refreshQueue();
    return stored;
  }

  /**
   * The tail of every serialized link: record the intent, and — on a device that cannot record it —
   * send it here, still inside the chain.
   *
   * Returns the identity when a queue row exists and the caller should kick the engine, and
   * `undefined` when there is nothing further to do: the mutation was refused, or it has already
   * been sent by `sendUnstored`.
   */
  async function stageOrSend(identity: MutationIdentity): Promise<MutationIdentity | undefined> {
    const stored = await stage(identity);
    if (stored === undefined) {
      return undefined;
    }

    if (stored) {
      return identity;
    }

    await sendUnstored(identity);
    return undefined;
  }

  /**
   * The storage-less path. This device cannot store anything (private browsing, or quota) and the
   * badge already says so. The queue is the only path to the server, so a command with no row would
   * simply vanish — and M7's rule is that a storage failure never breaks a command. It is sent
   * directly, through the same code a pass would have used.
   *
   * **It runs inside the serialized link, unlike the queued path's `sync()`.** `identityFor` stamps
   * `baseVersion` from the projection, and the projection over a device with no queue is the cached
   * order alone: nothing advances it until an answer comes back. Attempt this outside the chain and
   * two rapid taps both carry the same version — one applies, the rest conflict, on a device whose
   * whole problem is that it has no queue to halt. So here the network round trip is the ordering,
   * and the till is as slow as the server for as long as storage is refusing writes. That is the
   * trade M7 already made; this only makes it correct.
   */
  async function sendUnstored(identity: MutationIdentity): Promise<void> {
    inFlight.value += 1;
    try {
      await engine.attemptOnce({
        ...identity,
        createdAt: new Date().toISOString(),
        status: 'PENDING',
      });
    } finally {
      inFlight.value -= 1;
    }
  }

  /** The identity of a new mutation for the order on screen, stamped at the projected version. */
  function identityFor(
    type: MutationType,
    terminalId: string,
    restaurantId: string,
    payload: MutationRequest['payload'],
  ): MutationIdentity | undefined {
    const orderId = currentOrderId.value;
    if (orderId === undefined) {
      return undefined;
    }

    return {
      orderId,
      mutationId: crypto.randomUUID(),
      terminalId,
      restaurantId,
      type,
      // The projected version, not the canonical one: offline this client is the only writer, so
      // it can predict what the server will produce and stamp the mutation behind this one at the
      // version this one will create. See `nextBaseVersion`.
      baseVersion: nextBaseVersion(projected.value),
      payload,
    };
  }

  /**
   * Restore this terminal's state after a reload, then read the canonical snapshot and drain.
   *
   * **Hydration is a second writer for state that already has an owner**, and every rule has to
   * hold across a reload as well as across a screen:
   *
   * - the snapshot goes through `adopt`, so the monotonic-version rule still refuses a cached
   *   snapshot older than one a refetch has already installed, and it is installed only when
   *   nothing is held — `adopt` accepts a *different* order unconditionally, which is how a
   *   `CREATE_ORDER` response installs a new aggregate and would also let a slow disk read
   *   replace the order the operator created while it was in flight;
   * - `SYNCING` rows are put back to `PENDING` **before** the queue is read. That label means
   *   "this tab, right now"; a crash leaves it with nothing behind it, and the engine would
   *   otherwise be looking at a mutation it believes someone else is attempting;
   * - the restored `mutationId`s are the stored ones. Minting fresh ones would turn a re-send into
   *   a second mutation at a stale `baseVersion` — a duplicate order, or a conflict reported over
   *   an operation that in fact succeeded;
   * - nothing is written at all if the screen has moved to another terminal, or has gone away
   *   entirely, which the generation is what detects.
   */
  async function hydrate(terminalId: string): Promise<void> {
    const mine = terminalGeneration;
    await localStore.normalizeSyncing(terminalId);
    const restored = await localStore.readTerminalState(terminalId);

    if (mine !== terminalGeneration || activeTerminalId.value !== terminalId) {
      return;
    }

    if (currentOrderId.value === undefined) {
      currentOrderId.value = restored.currentOrderId;
    }
    if (restored.order !== undefined && order.value === undefined) {
      adopt(restored.order);
    }
    // Re-read rather than installing what was read a moment ago: a mutation enqueued while this
    // was in flight is already on disk, and assigning the older list would drop it from the mirror.
    await refreshQueue();

    // The cache is never authoritative (ADR 013), and this refresh belongs to hydration rather
    // than to the view: the socket's own reconnect refetch does not run at all when
    // `realtime.websocket_push` is off or `GET /api/config` fails.
    await refetch();
    // Anything the previous session left unsent goes now, in local creation order.
    await sync();
    await localStore.pruneOrders();
  }

  /**
   * The canonical read (§13). Every socket message that survives the gate ends here rather than
   * being applied as a payload: the server owns the arithmetic, the browser only displays it.
   */
  async function refetch(): Promise<void> {
    const id = currentOrderId.value;
    const terminalId = activeTerminalId.value;
    if (id === undefined) {
      return;
    }

    // A socket event triggers this without awaiting it, so a rejection here would surface as an
    // unhandled promise rejection and nowhere else. A failed refresh only means the screen stays
    // as it is until the next event or reconnect — worth saying, not worth throwing. A terminal
    // that is simulating an offline device fails here too, which is the point (§19.3).
    let snapshot: OrderSnapshot | undefined;
    try {
      snapshot = await fetchOrder(id, terminalId);
    } catch (error) {
      // Reported only if the screen is still asking this question.
      if (currentOrderId.value === id) {
        readError.value = error instanceof Error ? error.message : 'The order could not be read.';
      }
      return;
    }

    // The screen may have moved to another order — or to none — while this was in flight.
    if (snapshot !== undefined && currentOrderId.value === id) {
      readError.value = undefined;
      adopt(snapshot);

      if (terminalId !== undefined) {
        await localStore.saveOrder(terminalId, snapshot);
      }
    }
  }

  async function createOrder(
    terminalId: string,
    restaurantId: string,
    tableNumber: string,
  ): Promise<void> {
    const payload: CreateOrderPayload = { tableNumber };
    const orderId = crypto.randomUUID();

    // **The pointer moves inside the chain, not before it.** Item taps no longer wait for the
    // server, so an operator can open the next cover while the last taps for this one are still
    // staging. Moving `currentOrderId` here would re-point those taps mid-flight: they would be
    // stamped for an order whose `CREATE_ORDER` is queued *behind* them, and the first one to
    // reach the server would halt on `ORDER_NOT_FOUND`. Queued behind them instead, they finish
    // against the order they were meant for and this one starts clean.
    const staged = await serialize(async () => {
      order.value = undefined;
      conflict.value = undefined;
      currentOrderId.value = orderId;

      // The pointer is durable now, not when an answer arrives. An order created offline never
      // gets an answer, and without the pointer the next reload would find its `CREATE_ORDER` in
      // the queue with nothing saying this device is on it — §14's "a reload must not lose
      // unsynced data".
      await localStore.setCurrentOrder(terminalId, orderId);

      const identity: MutationIdentity = {
        orderId,
        mutationId: crypto.randomUUID(),
        terminalId,
        restaurantId,
        type: 'CREATE_ORDER',
        baseVersion: 0,
        payload,
      };

      return stageOrSend(identity);
    });

    if (staged !== undefined) {
      await sync();
    }
  }

  /**
   * What a command turns out to be, decided **inside** the serialized link.
   *
   * A caller that already knows both passes a constant; one whose mutation depends on the order —
   * the ± steppers — passes a function, and it is evaluated against the projection at the moment
   * the command is staged rather than at the moment the finger landed.
   */
  interface CommandPlan {
    type: MutationType;
    payload: MutationRequest['payload'];
  }

  /**
   * Every command refuses while the aggregate is halted: §14.1 waits for a human.
   *
   * The halt check, the plan, the identity and the queue write are **one indivisible step**. All
   * four read the projection, and a command that read it between another command's write and its
   * own would stamp a stale `baseVersion` — or, for a stepper, a stale quantity.
   */
  async function command(
    terminalId: string,
    restaurantId: string,
    plan: () => CommandPlan | undefined,
  ): Promise<void> {
    // The order the operator was looking at when they touched the screen. `createOrder` and
    // `clear` move the pointer inside this same chain, so by the time the link runs the pointer is
    // either still this order or has deliberately moved on — and a tap meant for an order the
    // screen has left must not be re-stamped onto the one that replaced it.
    const intended = currentOrderId.value;

    const staged = await serialize(async () => {
      if (halted.value) {
        lastError.value = 'This order is halted on a conflict. Discard or rebase first.';
        return undefined;
      }

      if (currentOrderId.value !== intended) {
        lastError.value = 'That action was for an order this screen has left; it was not sent.';
        return undefined;
      }

      const planned = plan();
      if (planned === undefined) {
        return undefined;
      }

      const identity = identityFor(planned.type, terminalId, restaurantId, planned.payload);
      if (identity === undefined) {
        return undefined;
      }

      return stageOrSend(identity);
    });

    if (staged !== undefined) {
      await sync();
    }
  }

  /** The common case: the caller knows the whole mutation before the chain runs. */
  const fixedCommand = (
    type: MutationType,
    terminalId: string,
    restaurantId: string,
    payload: MutationRequest['payload'],
  ): Promise<void> => command(terminalId, restaurantId, () => ({ type, payload }));

  const addItem = (
    terminalId: string,
    restaurantId: string,
    productId: string,
    quantity = 1,
  ): Promise<void> =>
    fixedCommand('ADD_ITEM', terminalId, restaurantId, { productId, quantity } as AddItemPayload);

  const removeItem = (terminalId: string, restaurantId: string, productId: string): Promise<void> =>
    fixedCommand('REMOVE_ITEM', terminalId, restaurantId, { productId } as RemoveItemPayload);

  /**
   * The absolute quantity, not a delta. A delta sent twice after a lost response would apply
   * twice; an absolute value cannot, and the operator's intent — "make it three" — is what the
   * screen actually knows.
   */
  async function changeQuantity(
    terminalId: string,
    restaurantId: string,
    productId: string,
    quantity: number,
  ): Promise<void> {
    // Zero is a removal and has its own mutation type; the API refuses it on this one.
    if (quantity < 1) {
      await removeItem(terminalId, restaurantId, productId);
      return;
    }

    await fixedCommand('CHANGE_QUANTITY', terminalId, restaurantId, {
      productId,
      quantity,
    } as ChangeQuantityPayload);
  }

  /**
   * One step of the ± stepper, and **the only thing the screen's buttons call**.
   *
   * The wire format is still an absolute quantity — a delta sent twice after a lost response would
   * apply twice, and §8 has not moved. What moved is *where the absolute value is computed*. The
   * template used to pass `item.quantity + 1`, read off the rendered row: with taps no longer
   * waiting for the server, several of them can be queued while that row still shows the old
   * number, so one `+` would overwrite every add behind it, and two quick `+` would both send the
   * same value — 1 → 2 instead of 1 → 3.
   *
   * Here the line is read from the projection *inside* the serialized link, which by then includes
   * every earlier tap. A stepper on a line the order no longer has plans nothing rather than
   * inventing one: another terminal removing it is canonical state disagreeing with a stale
   * render, and §8 answers a `CHANGE_QUANTITY` for a missing line with `ITEM_NOT_IN_ORDER`.
   */
  const stepQuantity = (
    terminalId: string,
    restaurantId: string,
    productId: string,
    delta: number,
  ): Promise<void> =>
    command(terminalId, restaurantId, () => {
      const held = projected.value?.items.find((item) => item.productId === productId);
      if (held === undefined) {
        return undefined;
      }

      const next = held.quantity + delta;
      // Zero is a removal and has its own mutation type; the API refuses it on the other one.
      return next < 1
        ? { type: 'REMOVE_ITEM', payload: { productId } as RemoveItemPayload }
        : {
            type: 'CHANGE_QUANTITY',
            payload: { productId, quantity: next } as ChangeQuantityPayload,
          };
    });

  const sendToKitchen = (terminalId: string, restaurantId: string): Promise<void> =>
    fixedCommand('SEND_TO_KITCHEN', terminalId, restaurantId, {});

  /** No amount is sent: the server pays the order's own canonical total (§8). */
  const pay = (terminalId: string, restaurantId: string, method: PaymentMethod): Promise<void> =>
    fixedCommand('PAY', terminalId, restaurantId, { method } as PayPayload);

  const cancel = (terminalId: string, restaurantId: string, reason?: string): Promise<void> =>
    fixedCommand(
      'CANCEL',
      terminalId,
      restaurantId,
      (reason === undefined ? {} : { reason }) as CancelPayload,
    );

  /**
   * §14.1's first resolution: give up on the halted mutations for this order.
   *
   * The conflicted mutation and everything blocked behind it go together. The canonical order the
   * server returned stays on screen — that is what the operator is accepting.
   */
  async function discardHalted(): Promise<void> {
    const terminalId = activeTerminalId.value;
    const orderId = currentOrderId.value;
    if (terminalId === undefined || orderId === undefined) {
      return;
    }

    const held = queuedIdsFor(orderId);
    await localStore.discardOrderQueue(terminalId, orderId);
    await refreshQueue();
    conflict.value = undefined;
    lastError.value = undefined;
    reportResolution(terminalId, orderId, 'DISCARDED', held);
  }

  /**
   * §14.1's second resolution: re-issue the halted mutations onto the server's current state, one
   * at a time, each with a new `mutationId`. Any of them may conflict again — a rebase onto a
   * cancelled order fails on the first attempt and the rest stay blocked.
   */
  async function rebaseHalted(): Promise<void> {
    const terminalId = activeTerminalId.value;
    const orderId = currentOrderId.value;
    if (terminalId === undefined || orderId === undefined) {
      return;
    }

    const held = queuedIdsFor(orderId);
    conflict.value = undefined;

    inFlight.value += 1;
    try {
      await engine.rebase(terminalId, orderId);
    } finally {
      inFlight.value -= 1;
    }

    // Reported **after** the rebase, and only for the mutations that actually left the queue. The
    // first `reissue` can fail to commit, in which case the original `CONFLICT` row is untouched and
    // nothing has been resolved; and a step that conflicts again is a *new* mutation with a new id,
    // so it cannot be closed by this report however late it arrives.
    await refreshQueue();
    reportResolution(terminalId, orderId, 'REBASED', held);
  }

  /** The mutations this device currently holds for one order, in queue order. */
  function queuedIdsFor(orderId: string): string[] {
    return queue.value.filter((row) => row.orderId === orderId).map((row) => row.mutationId);
  }

  /**
   * Tell the server that §14.1 was answered here.
   *
   * `held` is what the queue held *before* the resolution; anything still in it afterwards was not
   * resolved — `discardOrderQueue` swallows a storage failure by design (M7: a storage failure never
   * breaks a command), and a rebase can stop part-way. So the report is the difference, and an
   * attempt that changed nothing sends nothing rather than closing a row over a queue that is still
   * halted.
   *
   * Deliberately not awaited and deliberately swallowed: the queue is already unblocked on this
   * device, and `conflict_log.resolution` feeds `/debug` and nothing else. Making the operator wait
   * on it, or showing them an error for it, would put an observability field in front of a till.
   */
  function reportResolution(
    terminalId: string,
    orderId: string,
    resolution: ConflictResolution,
    held: readonly string[],
  ): void {
    const stillQueued = new Set(queuedIdsFor(orderId));
    const cleared = held.filter((mutationId) => !stillQueued.has(mutationId));
    if (cleared.length === 0) {
      return;
    }

    // `void fn().catch()` would not be enough: `postConflictResolution` calls `assertOnline`, which
    // throws **synchronously** on a terminal holding §18's offline switch — before there is a
    // promise to attach a handler to. Offline is exactly when §19.3 discards a halted queue, so
    // that throw would come out of the resolution the operator just chose.
    void (async () => postConflictResolution(orderId, terminalId, resolution, cleared))().catch(
      () => undefined,
    );
  }

  /**
   * Go back to an order this screen has left — the one action that makes a halt reachable again.
   *
   * The pointer moves with it, because the pointer is precisely "which order is this device on".
   * The cached snapshot comes off disk so the canonical half of §14.1's panel is populated before
   * the refetch answers, which matters most in the case this exists for: the terminal is offline
   * and the refetch will not answer at all.
   */
  async function focusOrder(orderId: string): Promise<void> {
    if (activeTerminalId.value === undefined || orderId === currentOrderId.value) {
      return;
    }

    // **Serialized for the same reason `createOrder` and `clear` are.** `command` captures the
    // pointer the instant the screen is touched and compares it inside its own link, so a pointer
    // moved *outside* the chain refuses every tap already accepted at rush speed: three taps and
    // then "Take it" used to lose all three to "that action was for an order this screen has left".
    // Inside the chain, every earlier tap is already in front of this link and gets stamped for the
    // order it was meant for. Found by the Codex review of M23, which put a second caller on this
    // function; the defect was M16's and "Go to it" had it too.
    const moved = await serialize(async () => {
      const terminalId = activeTerminalId.value;
      // Re-checked inside the link: the pointer may have moved while this was queued behind a tap.
      if (terminalId === undefined || orderId === currentOrderId.value) {
        return false;
      }

      order.value = undefined;
      conflict.value = undefined;
      readError.value = undefined;
      currentOrderId.value = orderId;

      await localStore.setCurrentOrder(terminalId, orderId);
      const cached = await localStore.readOrder(orderId);
      if (cached !== undefined && order.value === undefined && currentOrderId.value === orderId) {
        adopt(cached);
      }
      return true;
    });

    // Outside the link, deliberately: this is a network read, and holding the local phase across it
    // would stall every tap on the order that was just opened — offline, for good.
    if (moved) {
      await refetch();
    }
  }

  /**
   * Start over on this screen. **The queue deliberately survives**: pressing "New order" is not an
   * answer to "did those mutations apply?", and the engine goes on syncing the order this screen
   * has left — the halt and the queue are per aggregate, not per screen (§21.8).
   */
  async function clear(): Promise<void> {
    // Serialized for the same reason `createOrder` is: this drops the pointer, and a tap still
    // staging behind it must be stamped for the order it was meant for, not find the pointer gone
    // underneath it. Every earlier tap is already in front of this link.
    await serialize(async () => {
      order.value = undefined;
      currentOrderId.value = undefined;
      conflict.value = undefined;
      lastError.value = undefined;
      readError.value = undefined;

      const terminalId = activeTerminalId.value;
      if (terminalId !== undefined) {
        await localStore.clearCurrentOrder(terminalId);
      }
    });
  }

  /**
   * The screen is going away, but the till has not finished with the table.
   *
   * `clear()` is an operator saying "done with this cover"; **leaving the route is not that**. Until
   * M16 `onBeforeUnmount` called `clear()`, so glancing at `/debug` or `/demo` and coming back lost
   * the order — and, because §18's one-shots are armed on `/demo` and live in the tab (ADR 015),
   * an arm could only ever be spent on the `CREATE_ORDER` that the emptied till had to start with.
   * Three of the eleven controls were undemonstrable on an item.
   *
   * So this drops the **in-memory** view and leaves the pointer on disk for the next `hydrate()`.
   * The in-memory half still has to go: the store outlives the component, and POS-1's order sitting
   * in `order.value` while POS-2 mounts would be drawn on POS-2 until its own read answered.
   *
   * Serialized for `clear()`'s reason: a tap still staging must not find the pointer moved beneath
   * it. The queue is untouched either way — it is per aggregate, not per screen (§21.8).
   */
  async function detach(): Promise<void> {
    await serialize(() => {
      order.value = undefined;
      currentOrderId.value = undefined;
      conflict.value = undefined;
      lastError.value = undefined;
      readError.value = undefined;
      // Nothing here touches disk; the link exists for its ordering, not for its awaiting.
      return Promise.resolve();
    });
  }

  return {
    order,
    projected,
    currentOrderId,
    conflict,
    currentConflict,
    lastError,
    readError,
    queue,
    currentQueue,
    pendingCount,
    pendingForOtherOrders,
    halted,
    conflictedMutation,
    blockedMutations,
    haltedElsewhere,
    focusOrder,
    useTerminal,
    releaseTerminal,
    hydrate,
    version,
    canonicalVersion,
    syncing,
    adopt,
    refetch,
    sync,
    createOrder,
    addItem,
    removeItem,
    changeQuantity,
    stepQuantity,
    sendToKitchen,
    pay,
    cancel,
    discardHalted,
    rebaseHalted,
    clear,
    detach,
  };
});
