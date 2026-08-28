import type { MutationRequest, MutationResponse, OrderSnapshot } from '@pos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../src/api/errors';
import { OfflineError } from '../src/api/offline';
import { db } from '../src/persistence/db';
import { localStore } from '../src/persistence/local-store';
import { createSyncEngine, type HaltCause } from '../src/sync/engine';

/**
 * The engine against the **real** repository over a real IndexedDB implementation, with only the
 * server scripted. Mocking Dexie here would hide the two things these tests are actually about —
 * that the halt is written as one transaction, and that the queue comes back in creation order.
 */

function snapshot(
  id: string,
  version: number,
  status: OrderSnapshot['status'] = 'OPEN',
): OrderSnapshot {
  return {
    id,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status,
    version,
    totalCents: 0,
    items: [],
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

const applied = (orderId: string, version: number): MutationResponse => ({
  status: 'APPLIED',
  order: snapshot(orderId, version),
  serverVersion: version,
});

const conflicted = (
  orderId: string,
  clientBaseVersion: number,
  serverVersion: number,
): MutationResponse => ({
  status: 'CONFLICT',
  reason: 'ORDER_CANCELLED',
  clientBaseVersion,
  serverVersion,
  canonicalOrder: snapshot(orderId, serverVersion, 'CANCELLED'),
});

/**
 * Rows are ordered by `createdAt`, so the queue has to be built with distinct, increasing ones —
 * three `savePending` calls in the same millisecond would leave the order to the index's tiebreak
 * rather than to the operator's actions.
 */
async function queueMutation(
  mutationId: string,
  orderId: string,
  baseVersion: number,
  createdAt: string,
): Promise<void> {
  vi.setSystemTime(new Date(createdAt));
  await localStore.savePending({
    mutationId,
    restaurantId: 'demo-restaurant',
    terminalId: 'pos-1',
    orderId,
    baseVersion,
    type: 'ADD_ITEM',
    payload: { productId: 'burger', quantity: 1 },
    status: 'PENDING',
  });
}

interface Harness {
  post: ReturnType<typeof vi.fn>;
  canonical: OrderSnapshot[];
  halts: HaltCause[];
  engine: ReturnType<typeof createSyncEngine>;
}

function harness(canonicalVersion = 5): Harness {
  const post = vi.fn<(orderId: string, request: MutationRequest) => Promise<MutationResponse>>();
  const canonical: OrderSnapshot[] = [];
  const halts: HaltCause[] = [];
  let nextId = 0;

  const engine = createSyncEngine({
    post,
    newMutationId: () => `rebased-${(nextId += 1)}`,
    canonicalVersion: () => canonicalVersion,
    onCanonical: async (terminalId, order) => {
      canonical.push(order);
      await localStore.cacheOrder(terminalId, order);
    },
    onHalt: (_row, cause) => halts.push(cause),
    onQueueChanged: async () => undefined,
    onTransportError: () => undefined,
  });

  return { post, canonical, halts, engine };
}

beforeEach(() => {
  // `Date` only. Faking the timers as well would stall `fake-indexeddb`, which schedules its
  // transactions on real ones — and these tests exist to run against a real IndexedDB.
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('§21.7 — offline queue ordering', () => {
  it('syncs A, B and C in local creation order for the same order', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');
    await queueMutation('c', 'order-1', 7, '2026-08-28T10:00:02.000Z');

    const { post, engine } = harness();
    post.mockImplementation((orderId, request) =>
      Promise.resolve(applied(orderId, request.baseVersion + 1)),
    );

    expect(await engine.run('pos-1')).toBe('drained');

    // §14: one mutation at a time, each waiting for the canonical result of the one before it.
    expect(post.mock.calls.map(([, request]) => request.mutationId)).toEqual(['a', 'b', 'c']);
    // Every acknowledged mutation is deleted, so the queue is empty rather than merely marked.
    expect(await localStore.readQueue('pos-1')).toEqual([]);
  });

  it('stops at the first mutation the network refuses and keeps the rest', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');

    const { post, engine } = harness();
    post.mockRejectedValueOnce(new OfflineError('pos-1'));

    expect(await engine.run('pos-1')).toBe('offline');

    // B is never attempted: sending it at a `baseVersion` that assumes A applied, without knowing
    // whether A did, is the guess this engine never makes.
    expect(post).toHaveBeenCalledTimes(1);
    const rows = await localStore.readQueue('pos-1');
    expect(rows.map((row) => row.status)).toEqual(['PENDING', 'PENDING']);
  });

  it('leaves nothing marked SYNCING once a pass is over', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');

    const { post, engine } = harness();
    post.mockRejectedValueOnce(new Error('socket hang up'));
    await engine.run('pos-1');

    // `SYNCING` means "this tab, right now". A row that kept it would look to the next pass like a
    // mutation somebody else is already attempting.
    expect((await localStore.readQueue('pos-1'))[0]?.status).toBe('PENDING');
  });
});

describe('§21.8 — a conflict halts the queue for that order and only that order', () => {
  it('marks the conflict, blocks what is behind it, and never sends it', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');
    await queueMutation('c', 'order-1', 7, '2026-08-28T10:00:02.000Z');

    const { post, engine, canonical } = harness();
    post.mockResolvedValueOnce(conflicted('order-1', 5, 6));

    expect(await engine.run('pos-1')).toBe('halted');

    // B and C never reach the server: their `baseVersion` is provably stale, and sending them
    // would produce a cascade of conflicts that looks like a broken client.
    expect(post).toHaveBeenCalledTimes(1);
    const rows = await localStore.readQueue('pos-1');
    expect(rows.map((row) => [row.mutationId, row.status])).toEqual([
      ['a', 'CONFLICT'],
      ['b', 'BLOCKED'],
      ['c', 'BLOCKED'],
    ]);
    // The server's truth arrives with the refusal and is cached, so the operator can see the
    // canonical state next to their local intent.
    expect(canonical.at(-1)?.status).toBe('CANCELLED');
  });

  it('keeps syncing a mutation for a different order in the same queue', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');
    await queueMutation('other', 'order-2', 2, '2026-08-28T10:00:02.000Z');

    const { post, engine } = harness();
    post.mockResolvedValueOnce(conflicted('order-1', 5, 6));
    post.mockResolvedValueOnce(applied('order-2', 3));

    expect(await engine.run('pos-1')).toBe('halted');

    // The halt is per aggregate, because the order is the consistency boundary.
    expect(post.mock.calls.map(([, request]) => request.mutationId)).toEqual(['a', 'other']);
    expect((await localStore.readQueue('pos-1')).map((row) => row.mutationId)).toEqual(['a', 'b']);
  });

  it('does not re-send a halted group on the next pass', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');

    const { post, engine } = harness();
    post.mockResolvedValueOnce(conflicted('order-1', 5, 6));
    await engine.run('pos-1');

    // Nothing resolves itself: a reconnect, a new mutation elsewhere, a reload — none of them
    // un-halts an aggregate. Only a human does.
    expect(await engine.run('pos-1')).toBe('halted');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('blocks only the followers of the terminal that conflicted', async () => {
    // The database is shared by every tab on the origin, so two terminals can hold queued
    // mutations for one order. The order is the consistency boundary on the server; a queue
    // belongs to the device that formed it.
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');
    vi.setSystemTime(new Date('2026-08-28T10:00:02.000Z'));
    await localStore.savePending({
      mutationId: 'other-terminal',
      restaurantId: 'demo-restaurant',
      terminalId: 'pos-2',
      orderId: 'order-1',
      baseVersion: 6,
      type: 'ADD_ITEM',
      payload: { productId: 'burger', quantity: 1 },
      status: 'PENDING',
    });

    const { post, engine } = harness();
    post.mockResolvedValueOnce(conflicted('order-1', 5, 6));
    await engine.run('pos-1');

    // pos-2 had no conflict of its own, and could not resolve one: its Discard and Rebase act on
    // rows it does not own.
    expect((await localStore.readQueue('pos-2'))[0]?.status).toBe('PENDING');
    expect((await localStore.readQueue('pos-1')).map((row) => row.status)).toEqual([
      'CONFLICT',
      'BLOCKED',
    ]);
  });

  it('halts on MUTATION_ID_REUSED too, because it is not retryable either', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');

    const { post, engine } = harness();
    post.mockResolvedValueOnce({ status: 'MUTATION_ID_REUSED', reason: 'MUTATION_ID_REUSED' });

    expect(await engine.run('pos-1')).toBe('halted');
    expect(post).toHaveBeenCalledTimes(1);
    expect((await localStore.readQueue('pos-1')).map((row) => row.status)).toEqual([
      'CONFLICT',
      'BLOCKED',
    ]);
  });
});

describe('a refusal the server will repeat, and one it may not', () => {
  it('halts the aggregate on a permanent §17 error and keeps syncing the next order', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');
    await queueMutation('other', 'order-2', 2, '2026-08-28T10:00:02.000Z');

    const { post, engine } = harness();
    post.mockRejectedValueOnce(new ApiRequestError('PRODUCT_NOT_FOUND', 'No such product.', 404));
    post.mockResolvedValueOnce(applied('order-2', 3));

    expect(await engine.run('pos-1')).toBe('halted');

    // Left `PENDING` this would be re-sent by every trigger for ever, and because a transport
    // failure ends the pass, order-2 would never be tried at all — with no banner to say why.
    expect(post.mock.calls.map(([, request]) => request.mutationId)).toEqual(['a', 'other']);
    expect((await localStore.readQueue('pos-1')).map((row) => row.status)).toEqual([
      'CONFLICT',
      'BLOCKED',
    ]);
  });

  it('treats INTERNAL_ERROR as transport, because the next attempt may well succeed', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');

    const { post, engine } = harness();
    post.mockRejectedValueOnce(new ApiRequestError('INTERNAL_ERROR', 'Boom.', 500));

    expect(await engine.run('pos-1')).toBe('failed');

    // The asymmetry is deliberate: an unfamiliar code costs one pointless retry, and halting by
    // default would stop an aggregate behind a human-facing banner over a 500 that cleared itself.
    expect((await localStore.readQueue('pos-1'))[0]?.status).toBe('PENDING');
  });

  it('reports the refusal to the screen with its code', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');

    const { post, engine, halts } = harness();
    post.mockRejectedValueOnce(
      new ApiRequestError('VALIDATION_FAILED', 'quantity must be >= 1', 400),
    );
    await engine.run('pos-1');

    // No canonical state came back with it, so the screen has a reason and no banner — the halt
    // itself is visible because it is derived from the rows.
    expect(halts).toEqual([
      { kind: 'refused', reason: 'VALIDATION_FAILED: quantity must be >= 1' },
    ]);
  });
});

describe('one pass at a time, for the terminal that asked last', () => {
  it('drains the terminal requested during a running pass, not the one it started with', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    vi.setSystemTime(new Date('2026-08-28T10:00:01.000Z'));
    await localStore.savePending({
      mutationId: 'on-pos-2',
      restaurantId: 'second-restaurant',
      terminalId: 'pos-2',
      orderId: 'order-9',
      baseVersion: 1,
      type: 'ADD_ITEM',
      payload: { productId: 'burger', quantity: 1 },
      status: 'PENDING',
    });

    const { post, engine } = harness();
    let releaseFirst: (value: MutationResponse) => void = () => undefined;
    let firstSent: () => void = () => undefined;
    const sent = new Promise<void>((resolve) => {
      firstSent = resolve;
    });
    post.mockImplementationOnce(() => {
      firstSent();
      return new Promise<MutationResponse>((resolve) => {
        releaseFirst = resolve;
      });
    });
    post.mockImplementation((orderId, request) =>
      Promise.resolve(applied(orderId, request.baseVersion + 1)),
    );

    const first = engine.run('pos-1');
    await sent;

    // The operator walks to POS-2 while POS-1's pass is still in the air, and its hydration asks
    // for a sync. A boolean coalescing flag repeated the loop with POS-1 and left this queue
    // unsent — with push disabled there is no reconnect trigger to save it.
    const second = engine.run('pos-2');
    releaseFirst(applied('order-1', 6));
    await Promise.all([first, second]);

    expect(post.mock.calls.map(([, request]) => request.mutationId)).toEqual(['a', 'on-pos-2']);
    expect(await localStore.readQueue('pos-2')).toEqual([]);
  });

  it('still coalesces a second request for the same terminal into one pass', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');

    const { post, engine } = harness();
    post.mockImplementation((orderId, request) =>
      Promise.resolve(applied(orderId, request.baseVersion + 1)),
    );

    const [one, two] = await Promise.all([engine.run('pos-1'), engine.run('pos-1')]);

    expect(one).toBe(two);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('§14.1 resolutions', () => {
  it('discard drops the conflicted mutation and everything blocked behind it', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');
    await queueMutation('other', 'order-2', 2, '2026-08-28T10:00:02.000Z');

    const { post, engine } = harness();
    post.mockResolvedValueOnce(conflicted('order-1', 5, 6));
    post.mockResolvedValueOnce(applied('order-2', 3));
    await engine.run('pos-1');

    await localStore.discardOrderQueue('pos-1', 'order-1');

    expect(await localStore.readQueue('pos-1')).toEqual([]);
  });

  it('rebase re-issues one at a time, each at the version the previous one produced', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');

    const { post, engine } = harness(9);
    post.mockResolvedValueOnce(conflicted('order-1', 5, 9));
    await engine.run('pos-1');

    post.mockImplementation((orderId, request) =>
      Promise.resolve(applied(orderId, request.baseVersion + 1)),
    );
    expect(await engine.rebase('pos-1', 'order-1')).toBe('drained');

    const rebased = post.mock.calls.slice(1).map(([, request]) => request);
    // A new `mutationId` — the one place §14.1 says one must be minted — and **not** a batch
    // re-stamp: B goes at the version A produced, not at the same fresh one.
    expect(rebased.map((request) => request.mutationId)).toEqual(['rebased-1', 'rebased-2']);
    expect(rebased.map((request) => request.baseVersion)).toEqual([9, 10]);
    expect(await localStore.readQueue('pos-1')).toEqual([]);
  });

  it('does not send a re-issued mutation whose swap never committed', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');

    const { post, engine } = harness(9);
    post.mockResolvedValueOnce(conflicted('order-1', 5, 9));
    await engine.run('pos-1');

    vi.spyOn(db.pendingMutations, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'));
    expect(await engine.rebase('pos-1', 'order-1')).toBe('failed');

    // Posting a replacement that was never stored would leave the old CONFLICT row on disk, so a
    // later reload could rebase the same intent again under yet another fresh id — one intent,
    // applied twice. The transaction is atomic, so the halted group is exactly as it was.
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      (await localStore.readQueue('pos-1')).map((row) => [row.mutationId, row.status]),
    ).toEqual([['a', 'CONFLICT']]);
  });

  it('rebase stops on a second conflict and leaves the rest blocked', async () => {
    await queueMutation('a', 'order-1', 5, '2026-08-28T10:00:00.000Z');
    await queueMutation('b', 'order-1', 6, '2026-08-28T10:00:01.000Z');

    const { post, engine } = harness(9);
    post.mockResolvedValueOnce(conflicted('order-1', 5, 9));
    await engine.run('pos-1');

    // §14.1's own example: a rebase onto a cancelled order fails on the first attempt.
    post.mockResolvedValueOnce(conflicted('order-1', 9, 9));
    expect(await engine.rebase('pos-1', 'order-1')).toBe('halted');

    expect(post).toHaveBeenCalledTimes(2);
    const rows = await localStore.readQueue('pos-1');
    expect(rows.map((row) => [row.mutationId, row.status])).toEqual([
      ['rebased-1', 'CONFLICT'],
      ['b', 'BLOCKED'],
    ]);
    // The re-issued mutation kept its place in the queue rather than moving to the back of it.
    expect(rows[0]?.createdAt).toBe('2026-08-28T10:00:00.000Z');
  });
});
