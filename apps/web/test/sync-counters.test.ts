import type { MutationRequest, MutationResponse, OrderSnapshot } from '@pos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OfflineError } from '../src/api/offline';
import { localStore } from '../src/persistence/local-store';
import { createSyncEngine } from '../src/sync/engine';

/**
 * §20's two client counters. The server cannot observe an offline sync at all — a queued mutation
 * that finally arrives is indistinguishable from one typed a second ago — so they are counted here
 * and persisted, and these tests are what say the persisting works.
 */

function snapshot(id: string, version: number): OrderSnapshot {
  return {
    id,
    restaurantId: 'demo-restaurant',
    tableNumber: '12',
    status: 'OPEN',
    version,
    totalCents: 0,
    items: [],
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

async function queueMutation(mutationId: string, terminalId: string): Promise<void> {
  await localStore.savePending({
    mutationId,
    restaurantId: 'demo-restaurant',
    terminalId,
    orderId: 'order-a',
    baseVersion: 3,
    type: 'ADD_ITEM',
    payload: { productId: 'burger', quantity: 1 },
    status: 'PENDING',
  });
}

function engineWith(
  post: (orderId: string, request: MutationRequest) => Promise<MutationResponse>,
) {
  return createSyncEngine({
    post,
    newMutationId: () => 'rebased-1',
    canonicalVersion: () => 5,
    onCanonical: async () => undefined,
    onHalt: () => undefined,
    onQueueChanged: async () => undefined,
    onTransportError: () => undefined,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the offline sync counters', () => {
  it('counts a pass that emptied the queue as a success', async () => {
    await queueMutation('mutation-1', 'pos-1');
    const engine = engineWith(async () => ({
      status: 'APPLIED',
      order: snapshot('order-a', 4),
      serverVersion: 4,
    }));

    await engine.run('pos-1');

    expect(await localStore.readSyncCounters()).toEqual([
      { terminalId: 'pos-1', successes: 1, failures: 0, updatedAt: expect.any(String) },
    ]);
  });

  it('counts a pass stopped by the offline switch as a failure', async () => {
    await queueMutation('mutation-1', 'pos-1');
    const engine = engineWith(async () => {
      throw new OfflineError('pos-1');
    });

    await engine.run('pos-1');

    // From the operator's point of view a sync that did not happen is a sync that did not happen,
    // whether the network was gone or the server refused.
    const [counters] = await localStore.readSyncCounters();
    expect(counters).toMatchObject({ terminalId: 'pos-1', successes: 0, failures: 1 });
  });

  it('keeps a separate tally per terminal', async () => {
    await queueMutation('mutation-1', 'pos-1');
    await queueMutation('mutation-2', 'pos-2');
    const engine = engineWith(async () => ({
      status: 'APPLIED',
      order: snapshot('order-a', 4),
      serverVersion: 4,
    }));

    await engine.run('pos-1');
    await engine.run('pos-2');

    expect((await localStore.readSyncCounters()).map((row) => row.terminalId)).toEqual([
      'pos-1',
      'pos-2',
    ]);
  });

  it('accumulates across passes rather than overwriting the last one', async () => {
    const engine = engineWith(async () => ({
      status: 'APPLIED',
      order: snapshot('order-a', 4),
      serverVersion: 4,
    }));

    // An empty queue drains trivially, which is still a pass and still a success: the counter is
    // about passes, not about mutations.
    await engine.run('pos-1');
    await engine.run('pos-1');
    await engine.run('pos-1');

    expect((await localStore.readSyncCounters())[0]?.successes).toBe(3);
  });
});
