import type { MutationRequest } from '@pos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchOrder, postMutation } from '../src/api/client';
import {
  isTerminalOffline,
  OfflineError,
  resetOfflineTerminals,
  setTerminalOffline,
  toggleTerminalOffline,
} from '../src/api/offline';

/**
 * The §18 offline switch, tested where it lives: **in the API client**, not in a store.
 *
 * That is the whole design decision — the demo has to be deterministic, so it cannot depend on
 * DevTools, and the stores must not grow a second code path for "we are pretending to be offline".
 * What a store sees is what it would see if the network were genuinely gone.
 */

const request = (terminalId: string): MutationRequest =>
  ({
    mutationId: 'm-1',
    terminalId,
    restaurantId: 'demo-restaurant',
    baseVersion: 1,
    type: 'ADD_ITEM',
    payload: { productId: 'burger', quantity: 1 },
  }) as MutationRequest;

afterEach(() => {
  resetOfflineTerminals();
  vi.unstubAllGlobals();
});

describe('Simulate Offline', () => {
  it('is per terminal, because the demo runs two POS screens against one server', () => {
    setTerminalOffline('pos-1', true);

    expect(isTerminalOffline('pos-1')).toBe(true);
    expect(isTerminalOffline('pos-2')).toBe(false);

    expect(toggleTerminalOffline('pos-1')).toBe(false);
    expect(isTerminalOffline('pos-1')).toBe(false);
  });

  it('refuses a mutation from the offline terminal and lets the other one through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'APPLIED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    setTerminalOffline('pos-1', true);

    await expect(postMutation('order-1', request('pos-1'))).rejects.toBeInstanceOf(OfflineError);
    // Nothing left the browser: the gate is in front of `fetch`, not in front of the response.
    expect(fetchMock).not.toHaveBeenCalled();

    await postMutation('order-1', request('pos-2'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cuts off the canonical read as well as the write', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setTerminalOffline('pos-1', true);

    // §19.3 depends on this: a POS-1 that could still read would quietly learn that POS-2 had
    // cancelled the order, re-validate the versions its queue is stamped with, and the conflict
    // the scenario exists to demonstrate would never happen.
    await expect(fetchOrder('order-1', 'pos-1')).rejects.toBeInstanceOf(OfflineError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a read with no terminal alone', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'order-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setTerminalOffline('pos-1', true);

    // The gate is about a terminal pretending to be offline. A caller with no terminal — the menu,
    // the config — is not one of those, and blocking it would break bootstrap for every screen.
    await expect(fetchOrder('order-1')).resolves.toBeDefined();
  });
});
