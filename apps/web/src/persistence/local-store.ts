import type { MutationRequest, MutationType, OrderSnapshot } from '@pos/contracts';
import { ref, toRaw } from 'vue';

import {
  db,
  type PendingMutationRecord,
  type PendingMutationStatus,
  type PersistedOrderRecord,
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
  order: OrderSnapshot | undefined;
  pending: PendingMutationRecord | undefined;
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

export const localStore = {
  /**
   * Cache a canonical snapshot and point the terminal at it. One write, because the two facts are
   * only ever true together: this device is working on this order, and this is what it last knew
   * about it.
   */
  async saveOrder(terminalId: string, snapshot: OrderSnapshot): Promise<void> {
    const record: PersistedOrderRecord = {
      id: snapshot.id,
      terminalId,
      snapshot: plain(snapshot),
      updatedAt: now(),
    };

    await guarded(
      'Caching the order',
      () =>
        db.transaction('rw', db.orders, db.syncMetadata, async () => {
          await db.orders.put(record);
          await db.syncMetadata.put({
            terminalId,
            currentOrderId: snapshot.id,
            updatedAt: record.updatedAt,
          });
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
  }): Promise<void> {
    await guarded(
      'Recording the pending mutation',
      async () => {
        const existing = await db.pendingMutations.get(input.mutationId);
        await db.pendingMutations.put({
          ...input,
          payload: plain(input.payload),
          // The row keeps the moment the intent was formed, not the moment of the latest retry:
          // §14 syncs in local creation order, and a retry does not move a mutation to the back
          // of its own queue.
          createdAt: existing?.createdAt ?? now(),
        });
      },
      undefined,
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
   * What this terminal was holding when the tab went away.
   *
   * The pending row is the **earliest** unresolved one. Both screens keep a single slot today, so
   * there is normally at most one; reading the earliest rather than an arbitrary row means that
   * if M8's queue ever leaves several behind, hydration surfaces the one that blocks the rest.
   */
  async readTerminalState(terminalId: string): Promise<RestoredTerminalState> {
    return guarded(
      'Reading the local state',
      async () => {
        const metadata = await db.syncMetadata.get(terminalId);
        const orderId = metadata?.currentOrderId;
        const cached = orderId === undefined ? undefined : await db.orders.get(orderId);

        const pending = await db.pendingMutations
          .where('terminalId')
          .equals(terminalId)
          .sortBy('createdAt');

        return { order: cached?.snapshot, pending: pending[0] };
      },
      { order: undefined, pending: undefined },
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
};
