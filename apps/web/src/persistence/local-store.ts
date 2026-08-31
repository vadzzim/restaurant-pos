import type { MutationRequest, MutationType, OrderSnapshot } from '@pos/contracts';
import { ref, toRaw } from 'vue';

import { acceptsSnapshot } from '../domain/order-snapshot';
import {
  db,
  type PendingMutationRecord,
  type PendingMutationStatus,
  type PersistedOrderRecord,
  type SyncCounterRecord,
} from './db';

/**
 * The last storage failure, if there is one. A single exported ref rather than a field on either
 * store: both screens write the same database, and a device whose IndexedDB is refusing writes is
 * a property of the device, not of whichever screen noticed first.
 *
 * **It is never cleared by a later success.** A failed write is not retried, so the fact it states
 * — something this session meant to store is not stored — stays true however well the next write
 * goes. Clearing it would turn the badge into a liveness light for the database, when what the
 * operator needs to know is that this device can no longer be trusted to survive a reload.
 */
export const persistenceError = ref<string | undefined>();

/**
 * Everything a screen needs back after a reload, for one terminal.
 *
 * `pending` is a record, not an identity: the caller decides whether it may install it, and it
 * needs `status` and `createdAt` to explain what it is looking at.
 */
export interface RestoredTerminalState {
  /** Which order this device was working on. Set even when nothing was ever cached for it. */
  currentOrderId: string | undefined;
  order: OrderSnapshot | undefined;
  queue: PendingMutationRecord[];
}

/**
 * IndexedDB clones what it stores, and a Vue reactive proxy raises `DataCloneError` when cloned.
 * Every value that crosses into Dexie came out of a store, so it is unwrapped in exactly one
 * place — here, where that provenance is known — rather than at each of the eight call sites.
 */
function plain<T>(value: T): T {
  return toRaw(value);
}

/**
 * Run a storage operation so that it cannot break a command.
 *
 * IndexedDB is absent in private browsing on some browsers and refuses writes at quota on all of
 * them. Letting either reject inside `send()` would turn a durability problem into a lost
 * mutation — precisely the failure this storage exists to prevent. So a failure is recorded and
 * the neutral value is returned; the mutation still goes to the server, and the screen says the
 * device is not durable right now.
 */
async function guarded<T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    persistenceError.value = `${what} failed: ${detail}`;
    return fallback;
  }
}

const now = (): string => new Date().toISOString();

/**
 * The queue's own clock, and the reason it is not `now()`.
 *
 * The queue is read in `createdAt` order with `mutationId` as the tiebreak, and `mutationId` is a
 * random UUID — so two intents stamped inside the same millisecond are ordered arbitrarily, and the
 * one that stamped `baseVersion` 4 can be sent in front of the one that stamped 3. The server
 * refuses it and the aggregate halts on a race the operator never caused. M15's large touch targets
 * made same-millisecond taps ordinary rather than exotic.
 *
 * So the stamp is **strictly greater than every stamp already on disk**: never behind the wall
 * clock, never equal to a row that exists. A burst drifts a few milliseconds into the future, which
 * no reader minds — the field orders the queue, it does not date it, and §14 only ever asks it for
 * "local creation order".
 *
 * The high-water mark is read from the store on every call rather than held in a variable. One
 * indexed `last()` per queued mutation is cheaper than the alternative is subtle: a remembered mark
 * has to be seeded at load, would drift across a reload, and would be process state that no test
 * and no second tab could reset. Reading it makes the rule a property of the data.
 *
 * Not a per-terminal sequence, which is what `known-problems.md` proposed: a sequence needs a
 * column, an index and a Dexie upgrade to backfill, and buys nothing. Two terminals share a
 * database only in the simulator, and each queue is read — and ordered — on its own.
 */
async function queueStamp(): Promise<string> {
  const newest = await db.pendingMutations.orderBy('createdAt').last();
  const floor = newest === undefined ? 0 : Date.parse(newest.createdAt) + 1;
  return new Date(Math.max(Date.now(), floor)).toISOString();
}

/**
 * The monotonic half of a cache write, shared by `saveOrder` and `cacheOrder` so the rule has one
 * home here as well as one home in `acceptsSnapshot`. **Must be called inside a transaction that
 * holds `orders`** — the read and the compare are only sound under the same lock as the write.
 */
async function putSnapshotIfNewer(
  terminalId: string,
  snapshot: OrderSnapshot,
  updatedAt: string,
): Promise<void> {
  // Read by the incoming id, so `acceptsSnapshot`'s "a different order is always accepted" branch
  // cannot fire here: what is left of the rule is the version comparison, which is exactly the
  // half a cache needs.
  const held = await db.orders.get(snapshot.id);
  if (!acceptsSnapshot(held?.snapshot, snapshot)) {
    return;
  }

  const record: PersistedOrderRecord = {
    id: snapshot.id,
    terminalId,
    snapshot: plain(snapshot),
    updatedAt,
  };
  await db.orders.put(record);
}

/**
 * Queue order is `createdAt`, with `mutationId` as a tiebreak so two intents formed in the same
 * millisecond still have a total order — without it a "later than the head" filter could match
 * both of them, or neither.
 */
function isLaterInQueue(row: PendingMutationRecord, head: PendingMutationRecord): boolean {
  if (row.createdAt !== head.createdAt) {
    return row.createdAt > head.createdAt;
  }
  return row.mutationId > head.mutationId;
}

export const localStore = {
  /**
   * Cache a canonical snapshot and point the terminal at it.
   *
   * **The snapshot write is monotonic and the pointer write is not**, because they answer
   * different questions. Both callers that reach here — `send` with a mutation response and
   * `refetch` with a canonical read — can answer out of order: two overlapping refetches returning
   * v5 then v4, or a mutation response landing behind a newer refetch. `adopt` already refuses the
   * older one on screen, so an unguarded write here would leave memory at v5 and disk at v4, and
   * the next reload would hydrate the order backwards.
   *
   * The comparison is `acceptsSnapshot`'s — the same function `adopt` uses, imported rather than
   * restated, so memory and disk cannot come to disagree about which snapshot is newer. It is
   * taken **inside** the transaction: a caller that read the stored version and then wrote in a
   * second call would only move the same race down one level.
   *
   * The pointer moves either way — **but only because this caller has established that the screen
   * is on this order.** Between two answers for the *same* order, the stale one is still evidence
   * that the terminal is working on it, so refusing to move the pointer would leave a terminal
   * pointed at nothing because two answers arrived in an unlucky sequence. That reasoning does not
   * extend to an answer for an order the screen has left, which is why the sync engine uses
   * `cacheOrder` instead: see the note there.
   */
  async saveOrder(terminalId: string, snapshot: OrderSnapshot): Promise<void> {
    await guarded(
      'Caching the order',
      () =>
        db.transaction('rw', db.orders, db.syncMetadata, async () => {
          const updatedAt = now();
          await putSnapshotIfNewer(terminalId, snapshot, updatedAt);
          await db.syncMetadata.put({
            terminalId,
            currentOrderId: snapshot.id,
            updatedAt,
          });
        }),
      undefined,
    );
  },

  /**
   * Cache a canonical snapshot **without saying anything about which order the terminal is on.**
   *
   * The sync engine drains every order this terminal queued, including ones the screen left long
   * ago — that is what "the halt is per aggregate" buys. An answer for one of those is a fact
   * about the order and nothing else. Writing the pointer with it moves `currentOrderId` to an
   * order nobody is looking at, and the next reload hydrates that one instead: the operator comes
   * back to a till showing an order they finished, while the one they were ringing up is reachable
   * only through the halted-elsewhere list — or, if it is still only queued and the device is
   * offline, not at all.
   *
   * The pointer therefore belongs to the three actions that actually move the screen —
   * `createOrder`, `focusOrder` and `clearCurrentOrder` — plus `saveOrder`, whose caller has just
   * read the order the screen is on.
   */
  async cacheOrder(terminalId: string, snapshot: OrderSnapshot): Promise<void> {
    await guarded(
      'Caching the order',
      () =>
        db.transaction('rw', db.orders, async () => {
          await putSnapshotIfNewer(terminalId, snapshot, now());
        }),
      undefined,
    );
  },

  /**
   * Forget which order this terminal is working on, without forgetting the order.
   *
   * Pressing "New order" is not an answer to "did that mutation apply?", so the cached snapshot
   * and any pending mutation both survive — the pointer is the only thing that was about the
   * screen. `prune` is what eventually collects a snapshot nothing refers to any more.
   */
  async clearCurrentOrder(terminalId: string): Promise<void> {
    await guarded(
      'Clearing the current order',
      () => db.syncMetadata.put({ terminalId, updatedAt: now() }),
      undefined,
    );
  },

  /**
   * Record an intent before it is sent. `mutationId` is the primary key, so re-recording the same
   * mutation — a retry — updates the row rather than creating a second one.
   *
   * **Returns whether it is actually stored.** Every other operation here can fail silently, but
   * this one cannot: since M8 the queue is the *only* path to the server, so a row that was not
   * written is a command that would never be sent at all. The caller falls back to sending it
   * directly — a device whose IndexedDB refuses writes loses offline-first, not the order.
   */
  async savePending(input: {
    mutationId: string;
    restaurantId: string;
    terminalId: string;
    orderId: string;
    baseVersion: number;
    type: MutationType;
    payload: MutationRequest['payload'];
    status: PendingMutationStatus;
  }): Promise<boolean> {
    return guarded(
      'Recording the pending mutation',
      async () => {
        const existing = await db.pendingMutations.get(input.mutationId);
        await db.pendingMutations.put({
          ...input,
          payload: plain(input.payload),
          // The row keeps the moment the intent was formed, not the moment of the latest retry:
          // §14 syncs in local creation order, and a retry does not move a mutation to the back
          // of its own queue.
          createdAt: existing?.createdAt ?? (await queueStamp()),
        });
        return true;
      },
      false,
    );
  },

  async setPendingStatus(mutationId: string, status: PendingMutationStatus): Promise<void> {
    await guarded(
      'Updating the pending mutation',
      () => db.pendingMutations.update(mutationId, { status }),
      0,
    );
  },

  async deletePending(mutationId: string): Promise<void> {
    await guarded(
      'Deleting the pending mutation',
      () => db.pendingMutations.delete(mutationId),
      undefined,
    );
  },

  /**
   * What this terminal was holding when the tab went away: the pointer, the cached snapshot it
   * names, and the whole queue.
   *
   * The pointer is returned separately from the snapshot because the two can disagree, and the
   * disagreement is the interesting case: an order created while the device was offline has a
   * pointer and a `CREATE_ORDER` in the queue but **no cached snapshot at all**, because no
   * canonical answer has ever come back for it. Returning only the snapshot would lose that order
   * on a reload — which is the one thing §14 says must not happen.
   */
  async readTerminalState(terminalId: string): Promise<RestoredTerminalState> {
    return guarded(
      'Reading the local state',
      async () => {
        const metadata = await db.syncMetadata.get(terminalId);
        const orderId = metadata?.currentOrderId;
        const cached = orderId === undefined ? undefined : await db.orders.get(orderId);
        const queue = await db.pendingMutations
          .where('terminalId')
          .equals(terminalId)
          .sortBy('createdAt');

        return { currentOrderId: orderId, order: cached?.snapshot, queue };
      },
      { currentOrderId: undefined, order: undefined, queue: [] },
    );
  },

  /** One cached snapshot by id, for a screen returning to an order it left. */
  async readOrder(orderId: string): Promise<OrderSnapshot | undefined> {
    return guarded(
      'Reading the cached order',
      async () => (await db.orders.get(orderId))?.snapshot,
      undefined,
    );
  },

  /**
   * Point the terminal at an order there is no canonical snapshot for yet.
   *
   * `saveOrder` moves the pointer as a side effect of caching an answer, which covers every order
   * the server has confirmed. An order created offline has no answer and would otherwise be
   * invisible to the next reload: the queue row exists, but nothing says this device is on it.
   */
  async setCurrentOrder(terminalId: string, orderId: string): Promise<void> {
    await guarded(
      'Pointing the terminal at the order',
      () => db.syncMetadata.put({ terminalId, currentOrderId: orderId, updatedAt: now() }),
      undefined,
    );
  },

  /**
   * The whole of this terminal's queue, in local creation order (§14).
   *
   * The order is `createdAt`, not insertion order and not status: §14's reconnect algorithm syncs
   * in the order the operator formed the intents, and a rebase deliberately keeps the original
   * `createdAt` so a re-issued mutation stays in front of the ones it is still blocking.
   */
  async readQueue(terminalId: string): Promise<PendingMutationRecord[]> {
    return guarded(
      'Reading the queue',
      () => db.pendingMutations.where('terminalId').equals(terminalId).sortBy('createdAt'),
      [],
    );
  },

  /**
   * Put every `SYNCING` row for this terminal back to `PENDING`.
   *
   * **`SYNCING` means "this tab, right now", so it is not durable state.** A row is marked before
   * its request goes out and put back by the catch when no answer comes — but a crash between the
   * two leaves the label with nothing behind it, and the engine would then be looking at a
   * mutation it believes someone else is attempting. Hydration therefore rewrites the label before
   * the first pass. Re-sending a mutation that did in fact apply is safe and is the whole point of
   * a stable `mutationId`: §9 answers `ALREADY_APPLIED`.
   *
   * `CONFLICT` and `BLOCKED` are untouched: those two survive a reload on purpose, because the
   * halt they describe is waiting for a human, not for a request.
   */
  async normalizeSyncing(terminalId: string): Promise<void> {
    await guarded(
      'Recovering interrupted mutations',
      () =>
        db.pendingMutations
          .where('terminalId')
          .equals(terminalId)
          .filter((row) => row.status === 'SYNCING')
          .modify({ status: 'PENDING' }),
      0,
    );
  },

  /**
   * §14.1, as one write: the mutation the server refused becomes `CONFLICT`, and every mutation
   * queued **after it for the same order** becomes `BLOCKED`.
   *
   * One transaction because the two halves are one fact. If the head were labelled and the tab
   * died before the followers were, a reload would find rows that look sendable and whose
   * `baseVersion` is provably stale — the cascade of conflicts §14.1 exists to prevent. The engine
   * does not rely on that transaction alone: its send gate asks whether *every* row in the group is
   * `PENDING` or `SYNCING`, so the labels are what the operator reads and the derivation is what
   * the gate obeys.
   *
   * "After it" is by `createdAt`, the queue's own order, with `mutationId` as a tiebreak so two
   * intents formed in the same millisecond still have a total order.
   *
   * **And by the same terminal.** This database is shared by every tab on the origin, so two
   * terminals can hold queued mutations for one order — the order is the consistency boundary on
   * the *server*, but a queue belongs to the device that formed it. Blocking by `orderId` alone
   * halts a terminal that had no conflict of its own and cannot resolve one: its Discard and
   * Rebase act on rows it does not own.
   */
  async haltQueue(head: PendingMutationRecord): Promise<void> {
    await guarded(
      'Halting the queue',
      () =>
        db.transaction('rw', db.pendingMutations, async () => {
          await db.pendingMutations.update(head.mutationId, { status: 'CONFLICT' });
          await db.pendingMutations
            .where('orderId')
            .equals(head.orderId)
            .filter((row) => row.terminalId === head.terminalId && isLaterInQueue(row, head))
            .modify({ status: 'BLOCKED' });
        }),
      undefined,
    );
  },

  /**
   * Discard: the operator gives up on the whole halted group for one order.
   *
   * The conflicted mutation and everything blocked behind it go together, in one transaction.
   * Deleting the head alone would leave the followers sendable at a `baseVersion` the server has
   * already left behind — the same cascade, arrived at by a different route.
   */
  async discardOrderQueue(terminalId: string, orderId: string): Promise<void> {
    await guarded(
      'Discarding the halted mutations',
      () =>
        db.transaction('rw', db.pendingMutations, async () => {
          const ids = await db.pendingMutations
            .where('orderId')
            .equals(orderId)
            .filter((row) => row.terminalId === terminalId)
            .primaryKeys();

          await db.pendingMutations.bulkDelete(ids);
        }),
      undefined,
    );
  },

  /**
   * Rebase one mutation: the same intent, a **new `mutationId`**, a fresh `baseVersion`.
   *
   * This is the one place in the client where an id is regenerated, and §14.1 is explicit that it
   * must be — a rebase is a different mutation, and re-sending the old id would be answered
   * `ALREADY_APPLIED` for a mutation that never applied.
   *
   * Delete and insert are one transaction. Were they two, the insert would have to come first: two
   * rows for one intent are refused by the send gate and the operator resolves again, whereas
   * delete-first loses the intent with nothing left to recover it from.
   *
   * **`createdAt` is carried over.** The re-issued mutation is still in front of the ones it is
   * blocking; moving it to the back of the queue would reorder the operator's actions.
   *
   * **Returns `undefined` when the swap did not commit**, and the caller must then not send it.
   * This is the second place in M8 where `guarded`'s neutral value is not neutral: the old
   * `CONFLICT` row is still on disk, so posting a replacement that was never stored would let a
   * later reload rebase the same intent again under yet another fresh id — the same intent applied
   * twice, which is precisely what a stable `mutationId` exists to prevent. Dexie's transaction is
   * atomic, so a failure leaves the halted group exactly as it was and the operator can try again.
   */
  async reissue(
    previous: PendingMutationRecord,
    mutationId: string,
    baseVersion: number,
  ): Promise<PendingMutationRecord | undefined> {
    const reissued: PendingMutationRecord = {
      ...previous,
      payload: plain(previous.payload),
      mutationId,
      baseVersion,
      status: 'PENDING',
    };

    return guarded(
      'Re-issuing the mutation',
      async () => {
        await db.transaction('rw', db.pendingMutations, async () => {
          await db.pendingMutations.put(reissued);
          await db.pendingMutations.delete(previous.mutationId);
        });
        return reissued;
      },
      undefined,
    );
  },

  /**
   * The kitchen's unresolved commands **for one restaurant**.
   *
   * Every kitchen row carries the same `terminalId` — there is one kitchen display id and it is
   * shared by every restaurant — so the restaurant filter is what makes this tenant-safe. Reading
   * by terminal alone would restore restaurant A's commands onto B's rail, and retrying one would
   * send a cross-tenant mutation while the screen insisted it belonged there.
   */
  async readPendingForTerminalInRestaurant(
    terminalId: string,
    restaurantId: string,
  ): Promise<PendingMutationRecord[]> {
    return guarded(
      'Reading the pending commands',
      async () => {
        const rows = await db.pendingMutations
          .where('terminalId')
          .equals(terminalId)
          .sortBy('createdAt');

        return rows.filter((row) => row.restaurantId === restaurantId);
      },
      [],
    );
  },

  /**
   * Drop cached snapshots nothing refers to any more.
   *
   * An order row is worth keeping only while some terminal is pointed at it or some pending
   * mutation names it. Without this the table grows for the life of the browser profile: every
   * order a device ever displayed, kept forever to answer a reload that will never ask.
   */
  async pruneOrders(): Promise<void> {
    await guarded(
      'Pruning cached orders',
      () =>
        db.transaction('rw', db.orders, db.pendingMutations, db.syncMetadata, async () => {
          const referenced = new Set<string>();
          await db.syncMetadata.each((row) => {
            if (row.currentOrderId !== undefined) {
              referenced.add(row.currentOrderId);
            }
          });
          await db.pendingMutations.each((row) => referenced.add(row.orderId));

          const stale: string[] = [];
          await db.orders.each((row) => {
            if (!referenced.has(row.id)) {
              stale.push(row.id);
            }
          });

          await db.orders.bulkDelete(stale);
        }),
      undefined,
    );
  },

  /**
   * Record how one sync pass ended (§20: offline sync successes and failures).
   *
   * Read-modify-write inside a transaction, so two terminals syncing in two tabs cannot lose a
   * count to each other — they are different rows, but the same table and the same lock, and the
   * cheapest correct thing is to let Dexie serialise it.
   *
   * `guarded` like every other write here: a counter that could not be stored must never break a
   * sync pass. On a device with no IndexedDB the numbers stay zero, which is the same thing the
   * persistence banner is already saying.
   */
  async recordSyncOutcome(terminalId: string, succeeded: boolean): Promise<void> {
    await guarded(
      'Recording a sync outcome',
      () =>
        db.transaction('rw', db.syncCounters, async () => {
          const current = await db.syncCounters.get(terminalId);
          await db.syncCounters.put({
            terminalId,
            successes: (current?.successes ?? 0) + (succeeded ? 1 : 0),
            failures: (current?.failures ?? 0) + (succeeded ? 0 : 1),
            updatedAt: now(),
          });
        }),
      undefined,
    );
  },

  /** Every terminal's sync counters, for `/debug`. Ordered so the page does not have to sort. */
  async readSyncCounters(): Promise<SyncCounterRecord[]> {
    return guarded(
      'Reading the sync counters',
      async () =>
        (await db.syncCounters.toArray()).sort((left, right) =>
          left.terminalId.localeCompare(right.terminalId),
        ),
      [],
    );
  },
};
