import type { MutationRequest, MutationType, OrderSnapshot } from '@pos/contracts';
import Dexie, { type EntityTable } from 'dexie';

/**
 * The client-side database of §14: `orders`, `pendingMutations`, `syncMetadata`.
 *
 * These shapes are deliberately **not** in `@pos/contracts`. Nothing outside this browser ever
 * sees a row: they are storage records, not a wire contract, and putting them in the shared
 * package would make the API and the worker rebuild whenever the client changes how it caches.
 * What they do reuse from contracts is everything that *is* a contract — `MutationType`, the
 * mutation payloads, `OrderSnapshot` — so a stored intent is re-sendable without translation.
 */

/**
 * The §14 status union, in full, so M7 and M8 agree on the vocabulary.
 *
 * **M7 writes `PENDING` and `SYNCING` only.** The other three belong to the sync engine:
 * `CONFLICT` is a mutation the server refused with a 409, `BLOCKED` is every later mutation for
 * that same order under the §14.1 halt, and `SYNCED` is the acknowledged state a row passes
 * through before it is deleted. Declaring them here rather than in M8 keeps the schema stable
 * across the two milestones — a stored row written today must still be legible tomorrow.
 */
export const PENDING_MUTATION_STATUSES = [
  'PENDING',
  'SYNCING',
  'CONFLICT',
  'BLOCKED',
  'SYNCED',
] as const;

export type PendingMutationStatus = (typeof PENDING_MUTATION_STATUSES)[number];

/**
 * A mutation this device intends, or has sent without hearing back.
 *
 * `mutationId` is the primary key and is **never regenerated**. It is the whole reason the row is
 * durable: a retry that carries the same id is answered `ALREADY_APPLIED` by §9, and a retry that
 * carries a fresh one is a second order.
 */
export interface PendingMutationRecord {
  mutationId: string;
  restaurantId: string;
  terminalId: string;
  orderId: string;
  baseVersion: number;
  type: MutationType;
  payload: MutationRequest['payload'];
  createdAt: string;
  status: PendingMutationStatus;
}

/**
 * The last canonical snapshot the server gave us for this order — a cache, never the truth. Every
 * screen hydrates it and then refetches (§13); its one job is that a reload with the network down
 * still shows the operator the order they are holding.
 *
 * `terminalId` records which device cached it, so pruning and hydration can both reason per
 * device without joining through `syncMetadata`.
 */
export interface PersistedOrderRecord {
  id: string;
  terminalId: string;
  snapshot: OrderSnapshot;
  updatedAt: string;
}

/**
 * Per-device sync state. Keyed by `terminalId` because the terminal is what survives a reload —
 * the tab, the route and the Pinia store do not. M8 adds fields here (last sync attempt, the
 * halted aggregate); M7 adds none beyond the pointer.
 */
export interface SyncMetadataRecord {
  terminalId: string;
  currentOrderId?: string;
  updatedAt: string;
}

export class PosDatabase extends Dexie {
  declare orders: EntityTable<PersistedOrderRecord, 'id'>;
  declare pendingMutations: EntityTable<PendingMutationRecord, 'mutationId'>;
  declare syncMetadata: EntityTable<SyncMetadataRecord, 'terminalId'>;

  constructor(name = 'pos-client') {
    super(name);

    // Only the indexes something already asks for, the same discipline the server schema keeps.
    // `createdAt` is indexed because §14's reconnect algorithm reads the queue in local creation
    // order; `orderId` and `terminalId` because hydration reads by aggregate and by device.
    this.version(1).stores({
      orders: 'id, terminalId',
      pendingMutations: 'mutationId, orderId, terminalId, createdAt',
      syncMetadata: 'terminalId',
    });
  }
}

export const db = new PosDatabase();
