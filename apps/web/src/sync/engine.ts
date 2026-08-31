import type {
  ApiErrorCode,
  ConflictReason,
  MutationRequest,
  MutationResponse,
  OrderSnapshot,
} from '@pos/contracts';

import { ApiRequestError } from '../api/errors';
import { OfflineError } from '../api/offline';
import type { PendingMutationRecord } from '../persistence/db';
import { localStore } from '../persistence/local-store';

/**
 * §14's reconnect algorithm, and §14.1's halt.
 *
 * ```
 * load pending mutations in local creation order
 * -> send the first -> wait for the canonical server result
 * -> update the local order -> delete the acknowledged mutation -> send the next
 * ```
 *
 * The engine is the third writer of this client's state and the first that runs without a screen
 * asking it to. What it owns is stated in `docs/milestones/M08.md`; the two rules that matter most
 * here are that **the disk is the queue** — it re-reads rather than holding a list — and that it
 * writes to memory only while the terminal it is syncing is still the one on screen.
 */

/** Why a pass stopped. `drained` is the only one that means the queue is empty. */
export type PassOutcome = 'drained' | 'halted' | 'offline' | 'failed';

/**
 * Why an aggregate halted, in the two shapes the screen can act on: a §5 conflict, which carries
 * the server's canonical state to show beside the local intent, and a flat refusal, which carries
 * only a reason. Passing this rather than the raw response keeps the store out of the business of
 * knowing which `MutationResponse` members exist.
 */
export type HaltCause =
  | { kind: 'conflict'; reason: ConflictReason; clientBaseVersion: number; serverVersion: number }
  | { kind: 'refused'; reason: string };

/**
 * The §17 error codes that mean **this request will never succeed as it stands**, so retrying it
 * is a loop rather than a recovery.
 *
 * An explicit whitelist, and the default is asymmetric on purpose — the same shape and the same
 * reasoning as `RECORD_REJECTIONS` in the worker. An unfamiliar code, or `INTERNAL_ERROR`, is
 * treated as transport: the row stays `PENDING` and the next trigger tries again, which costs one
 * pointless retry if the fault was permanent. Halting by default would cost an aggregate stopped
 * by a human-facing banner over a 500 that cleared itself a second later.
 *
 * `ORDER_NOT_FOUND` is in the list because the engine is sequential per aggregate: a mutation only
 * reaches the server after the `CREATE_ORDER` in front of it was answered, so hearing that the
 * order does not exist means the creation was conflicted or discarded, and no number of retries
 * will conjure it back.
 */
const PERMANENT_API_ERRORS: readonly ApiErrorCode[] = [
  'VALIDATION_FAILED',
  'PRODUCT_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'ORDER_NOT_FOUND',
];

function isPermanentRefusal(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError && PERMANENT_API_ERRORS.includes(error.code as ApiErrorCode)
  );
}

export interface SyncEngineDeps {
  /** The write path. Injected so the tests can script a server without a socket or a fetch. */
  post: (orderId: string, request: MutationRequest) => Promise<MutationResponse>;
  /** A fresh `mutationId` for a rebase — the one place §14.1 says one must be minted. */
  newMutationId: () => string;
  /**
   * A canonical snapshot the server just gave us. It is cached unconditionally (the answer is true
   * whatever the screen is showing) and displayed only if the caller's claim is still current.
   */
  onCanonical: (terminalId: string, snapshot: OrderSnapshot) => Promise<void>;
  /** A mutation the server refused, and why, in a shape the screen can act on. */
  onHalt: (row: PendingMutationRecord, cause: HaltCause) => void;
  /** Something changed on disk; the store re-reads its mirror. */
  onQueueChanged: () => Promise<void>;
  /** The canonical version this client holds for an order — a rebase's first `baseVersion`. */
  canonicalVersion: (orderId: string) => number;
  /** The last transport failure, for the screen. */
  onTransportError: (message: string) => void;
}

/** What one attempted mutation did. `applied` carries the snapshot a rebase needs to re-stamp. */
type Attempt =
  | { kind: 'applied'; snapshot: OrderSnapshot }
  | { kind: 'halted' }
  | { kind: 'offline' }
  | { kind: 'failed' };

function requestOf(row: PendingMutationRecord): MutationRequest {
  return {
    mutationId: row.mutationId,
    terminalId: row.terminalId,
    restaurantId: row.restaurantId,
    baseVersion: row.baseVersion,
    type: row.type,
    payload: row.payload,
  } as MutationRequest;
}

/**
 * The send gate: a group may be sent only when **every** row in it is `PENDING` or `SYNCING`.
 *
 * Stated as a derivation rather than as a lookup of the head's `status`, because the two writes
 * that halt a queue — the head to `CONFLICT`, the followers to `BLOCKED` — are a pair, and a rule
 * that read only one of them would depend on the pair being atomic. It is atomic; the gate does
 * not rely on that. The same derivation also covers a rebase that stopped part-way, where the head
 * is `PENDING` again and its followers are still `BLOCKED`: a halted group leaves the halt only
 * through an explicit human resolution.
 */
export function isSendable(group: readonly PendingMutationRecord[]): boolean {
  return group.every((row) => row.status === 'PENDING' || row.status === 'SYNCING');
}

/** The queue split per aggregate, each group in creation order, groups in first-appearance order. */
export function groupByOrder(
  rows: readonly PendingMutationRecord[],
): Map<string, PendingMutationRecord[]> {
  const groups = new Map<string, PendingMutationRecord[]>();
  for (const row of rows) {
    const group = groups.get(row.orderId);
    if (group === undefined) {
      groups.set(row.orderId, [row]);
    } else {
      group.push(row);
    }
  }
  return groups;
}

export function createSyncEngine(deps: SyncEngineDeps) {
  /**
   * One pass at a time. A trigger that arrives while a pass is running does not start a second
   * one — it asks the running pass to loop again, so a mutation enqueued mid-pass is still synced
   * without two passes racing for the same row. The same shape as `createCoalescingLoader`.
   *
   * **What is coalesced is the terminal, not merely the fact that something asked.** A boolean
   * flag made the loop repeat with whatever terminal it had started with, so a route change during
   * a pass — the operator walking from POS-1 to POS-2 — left the new screen's queue unsent, with no
   * later trigger to save it when `realtime.websocket_push` is off. The pending request is
   * therefore the terminal id, and the next iteration runs for that one. Re-requesting the same
   * terminal, which is the ordinary mid-pass enqueue, behaves exactly as it did.
   */
  let running: Promise<PassOutcome> | undefined;
  let requested: string | undefined;

  async function attempt(row: PendingMutationRecord): Promise<Attempt> {
    // §14's ordering, unchanged since M7: the intent is durable before it is attempted, and
    // `SYNCING` is what a row is while a request for it is in the air.
    await localStore.setPendingStatus(row.mutationId, 'SYNCING');

    let response: MutationResponse;
    try {
      response = await deps.post(row.orderId, requestOf(row));
    } catch (error) {
      if (error instanceof OfflineError) {
        // The row survives, back to `PENDING`. The mutation may well have applied; the id that can
        // still settle it is the one thing that must not be lost.
        await localStore.setPendingStatus(row.mutationId, 'PENDING');
        return { kind: 'offline' };
      }

      // A §17 envelope the server will produce again for this exact request. Left `PENDING` it
      // would be re-sent by every trigger for ever, and — because a transport failure ends the
      // pass — the orders behind it would never be tried at all, with no banner to say why. It is
      // a refusal, so it halts its aggregate exactly as a conflict does and the operator gets
      // Discard and Rebase.
      if (isPermanentRefusal(error)) {
        await localStore.haltQueue(row);
        deps.onHalt(row, { kind: 'refused', reason: `${error.code}: ${error.message}` });
        return { kind: 'halted' };
      }

      await localStore.setPendingStatus(row.mutationId, 'PENDING');
      deps.onTransportError(error instanceof Error ? error.message : 'The mutation failed.');
      return { kind: 'failed' };
    }

    switch (response.status) {
      case 'APPLIED':
      case 'ALREADY_APPLIED':
        // Cached before the identity that could recover it is dropped. These two writes are not
        // atomic and the tab can die between them; a row that outlived its answer is resolved by
        // §9 on the re-send, whereas a deleted row with no cached snapshot loses a `CREATE_ORDER`.
        await deps.onCanonical(row.terminalId, response.order);
        await localStore.deletePending(row.mutationId);
        return { kind: 'applied', snapshot: response.order };

      case 'CONFLICT':
        // §14.1: the server's truth arrives with the refusal, so it is cached and shown before the
        // queue is halted — the operator has to see the canonical state next to the local intent.
        await deps.onCanonical(row.terminalId, response.canonicalOrder);
        await localStore.haltQueue(row);
        deps.onHalt(row, {
          kind: 'conflict',
          reason: response.reason,
          clientBaseVersion: response.clientBaseVersion,
          serverVersion: response.serverVersion,
        });
        return { kind: 'halted' };

      default:
        // `MUTATION_ID_REUSED` and `REJECTED` carry no snapshot: the server refused the mutation
        // outright, so its fate is known without one. Neither is retryable — leaving the row
        // `PENDING` would spin — so the aggregate halts and a human chooses. Rebase is the right
        // resolution for a reused id: it mints the fresh one the server objected to the lack of.
        await localStore.haltQueue(row);
        deps.onHalt(row, { kind: 'refused', reason: response.reason });
        return { kind: 'halted' };
    }
  }

  async function pass(terminalId: string): Promise<PassOutcome> {
    let outcome: PassOutcome = 'drained';

    for (const group of groupByOrder(await localStore.readQueue(terminalId)).values()) {
      // A halted aggregate is skipped, not sent: its `baseVersion`s are provably stale and sending
      // them would produce the cascade §14.1 exists to prevent. Other orders keep syncing — the
      // halt is per aggregate, because the order is the consistency boundary (§21.8).
      if (!isSendable(group)) {
        outcome = 'halted';
        continue;
      }

      for (const row of group) {
        const result = await attempt(row);
        if (result.kind === 'applied') {
          continue;
        }
        if (result.kind === 'halted') {
          outcome = 'halted';
          break;
        }
        // Transport, not domain: nothing else will get through either, so the pass ends here and
        // waits for a trigger. There is no timer — a retry loop would make the offline demo
        // non-deterministic and would hide the very state it is meant to show.
        return result.kind;
      }
    }

    return outcome;
  }

  async function loop(first: string): Promise<PassOutcome> {
    let terminalId = first;
    for (;;) {
      requested = undefined;
      const outcome = await pass(terminalId);
      // §20's offline sync counters, recorded per *pass* and attributed to the terminal the pass
      // actually ran for — which, thanks to the coalescing above, is not always the one that asked.
      // `drained` is the only outcome that emptied the queue; `offline` counts as a failure because
      // from the operator's point of view a sync that did not happen is a sync that did not happen.
      await localStore.recordSyncOutcome(terminalId, outcome === 'drained');
      await deps.onQueueChanged();
      if (requested === undefined) {
        return outcome;
      }
      terminalId = requested;
    }
  }

  return {
    /**
     * Attempt one mutation outside a pass.
     *
     * The one caller is a device whose IndexedDB refused the queue row. The queue is the only path
     * to the server, so a command with no row would otherwise be dropped — and M7's rule is that a
     * storage failure may never break a command. Everything this does to the queue is a repository
     * call that is already failure-tolerant, so on such a device the writes are no-ops and what is
     * left is the request and its answer.
     */
    attemptOnce: attempt,

    /**
     * Drain this terminal's queue.
     *
     * A call made while a pass is running joins it rather than starting a second one, and the
     * terminal it asked for is what the next iteration uses. The returned outcome is therefore the
     * last iteration's, which may be about a later terminal than the caller named — callers use it
     * for reporting, never as an answer about their own queue.
     */
    async run(terminalId: string): Promise<PassOutcome> {
      if (running !== undefined) {
        requested = terminalId;
        return running;
      }

      running = loop(terminalId).finally(() => {
        running = undefined;
      });
      return running;
    },

    /**
     * §14.1's rebase: re-issue the halted mutations for one order, **sequentially**, each with a
     * new `mutationId` at a fresh `baseVersion`.
     *
     * Not a batch re-stamp. The blocked mutations cannot all carry the same fresh version, because
     * each successful one advances it — so A goes at v6 and only once it applies does B go at v7.
     * The fresh version comes from the snapshot the previous step returned rather than from a
     * refetch: it is the exact number the server just produced, and asking again would open a
     * window for someone else's mutation to land in between.
     *
     * Any step may conflict again — a rebase onto a `CANCELLED` order fails on the first attempt
     * and the rest stay blocked. That is §14.1's own example, and it is why this is offered as a
     * choice rather than performed automatically: a silent auto-rebase is last-write-wins in
     * disguise.
     */
    async rebase(terminalId: string, orderId: string): Promise<PassOutcome> {
      let version = deps.canonicalVersion(orderId);
      let outcome: PassOutcome = 'drained';

      for (;;) {
        const group = (await localStore.readQueue(terminalId)).filter(
          (row) => row.orderId === orderId,
        );
        const head = group[0];
        if (head === undefined) {
          break;
        }

        // `CREATE_ORDER` is the one mutation whose `baseVersion` is not the current version: it
        // asserts the order does not exist yet, and §5 fixes that at 0.
        const baseVersion = head.type === 'CREATE_ORDER' ? 0 : version;
        const reissued = await localStore.reissue(head, deps.newMutationId(), baseVersion);

        // The swap did not commit, so the old `CONFLICT` row is still the durable record of this
        // intent. Sending a replacement that was never stored would let a later reload rebase the
        // same intent again under yet another fresh id — one intent, applied twice. The group is
        // untouched and still halted; the operator can press Rebase again.
        if (reissued === undefined) {
          outcome = 'failed';
          break;
        }

        const result = await attempt(reissued);
        if (result.kind !== 'applied') {
          outcome = result.kind === 'halted' ? 'halted' : result.kind;
          break;
        }
        version = result.snapshot.version;
      }

      await deps.onQueueChanged();
      return outcome;
    },
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
