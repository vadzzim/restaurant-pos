import type { MutationRequest } from '@pos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { postMutation } from '../src/api/client';
import { resetOfflineTerminals, setTerminalOffline } from '../src/api/offline';
import {
  isArmed,
  isLatched,
  resetSimulatorArms,
  setArm,
  simulatorEffects,
  toggleLatch,
} from '../src/api/simulator-arms';

/**
 * §18's client-side controls, tested where they act: **in the API client**, for the same reason the
 * offline switch is. A one-shot that only worked when a store called it would be a control that
 * the sync engine could route around; hanging them off `postMutation` means every write in the
 * application goes past them, and the tests here send real request bodies through `fetch`.
 */

const request = (overrides: Partial<MutationRequest> = {}): MutationRequest =>
  ({
    mutationId: 'm-1',
    terminalId: 'pos-1',
    restaurantId: 'demo-restaurant',
    baseVersion: 4,
    type: 'ADD_ITEM',
    payload: { productId: 'burger', quantity: 1 },
    ...overrides,
  }) as MutationRequest;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Every send answers `APPLIED`; the shadows are the interesting part, not the answers.
 *
 * A fresh `Response` per call, because a body can only be read once and these tests are the only
 * place in the suite where one `fetch` mock serves two requests.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ status: 'APPLIED' }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodiesSent = (fetchMock: ReturnType<typeof vi.fn>): MutationRequest[] =>
  fetchMock.mock.calls.map(
    (call) => JSON.parse((call[1] as RequestInit).body as string) as MutationRequest,
  );

afterEach(() => {
  resetSimulatorArms();
  resetOfflineTerminals();
  vi.unstubAllGlobals();
});

describe('Duplicate Next Mutation', () => {
  it('sends the identical body a second time, and is spent by the first mutation', async () => {
    const fetchMock = stubFetch();
    setArm('duplicate-next-mutation', true);

    await postMutation('order-1', request());

    const [first, second] = bodiesSent(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Byte-identical, because §9 tells a retry from a reuse on a hash of (orderId, type, payload).
    expect(second).toEqual(first);
    expect(isArmed('duplicate-next-mutation')).toBe(false);

    await postMutation('order-1', request({ mutationId: 'm-2' }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns the real response and never the shadow one', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'APPLIED', order: { version: 5 } }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ALREADY_APPLIED' }));
    vi.stubGlobal('fetch', fetchMock);
    setArm('duplicate-next-mutation', true);

    // The sync engine reads this. `ALREADY_APPLIED` leaking back would settle the row twice.
    const response = await postMutation('order-1', request());
    expect(response.status).toBe('APPLIED');
    expect(simulatorEffects.value[0]?.detail).toContain('ALREADY_APPLIED');
  });

  it('does not fire when the mutation did not apply', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        jsonResponse({ status: 'CONFLICT', reason: 'VERSION_MISMATCH' }, 409),
      );
    vi.stubGlobal('fetch', fetchMock);
    setArm('duplicate-next-mutation', true);

    await postMutation('order-1', request());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Still armed: there was nothing to duplicate, so the control has not been spent.
    expect(isArmed('duplicate-next-mutation')).toBe(true);
  });
});

describe('Reuse Mutation Id With New Payload', () => {
  it('keeps the id and sends a body the server must hash differently', async () => {
    const fetchMock = stubFetch();
    setArm('reuse-mutation-id', true);

    await postMutation('order-1', request());

    const [first, second] = bodiesSent(fetchMock);
    expect(second?.mutationId).toBe(first?.mutationId);
    expect(second?.type).not.toBe(first?.type);
    expect(second?.payload).not.toEqual(first?.payload);
    expect(isArmed('reuse-mutation-id')).toBe(false);
  });

  it('fires alongside the duplicate, so a demo can show §19.4 and §19.5 in one press', async () => {
    const fetchMock = stubFetch();
    setArm('duplicate-next-mutation', true);
    setArm('reuse-mutation-id', true);

    await postMutation('order-1', request());

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('Create Version Conflict', () => {
  it('sends the next mutation one version low and leaves the caller record alone', async () => {
    const fetchMock = stubFetch();
    setArm('create-version-conflict', true);

    const original = request({ baseVersion: 4 });
    await postMutation('order-1', original);

    expect(bodiesSent(fetchMock)[0]?.baseVersion).toBe(3);
    // The pending row the engine holds keeps its true version, so Rebase still has a base.
    expect(original.baseVersion).toBe(4);
    expect(isArmed('create-version-conflict')).toBe(false);
  });

  it('stays armed against a CREATE_ORDER, which is defined at version 0', async () => {
    const fetchMock = stubFetch();
    setArm('create-version-conflict', true);

    await postMutation(
      'order-1',
      request({ baseVersion: 0, type: 'CREATE_ORDER', payload: { tableNumber: '7' } }),
    );

    // A decrement here would be a 400 from the boundary schema, not the conflict the label
    // promises. The arm waits for a mutation it can actually spend itself on.
    expect(bodiesSent(fetchMock)[0]?.baseVersion).toBe(0);
    expect(isArmed('create-version-conflict')).toBe(true);
  });

  it('stays armed at v1, where a decrement is refused as invalid rather than as conflicting', async () => {
    const fetchMock = stubFetch();
    setArm('create-version-conflict', true);

    await postMutation('order-1', request({ baseVersion: 1 }));

    // `mutation-routes.ts` validates an existing order's baseVersion as `min(1)`, so v1 - 1 is a
    // VALIDATION_ERROR: the queue would not halt, and §19.3 would demonstrate nothing.
    expect(bodiesSent(fetchMock)[0]?.baseVersion).toBe(1);
    expect(isArmed('create-version-conflict')).toBe(true);

    // v2 is the first version it can tamper with and still produce a conflict.
    await postMutation('order-1', request({ baseVersion: 2, mutationId: 'm-2' }));
    expect(bodiesSent(fetchMock)[1]?.baseVersion).toBe(1);
    expect(isArmed('create-version-conflict')).toBe(false);
  });

  it('is spent by a request the server refused with an error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'no' } }, 400),
        ),
    );
    setArm('create-version-conflict', true);

    await expect(postMutation('order-1', request())).rejects.toThrow();

    // The request reached the server; the arm did its work. Leaving it armed would tamper with
    // every later mutation from this tab, which is a wedged till rather than a one-shot.
    expect(isArmed('create-version-conflict')).toBe(false);
  });
});

describe('the offline switch and the arms together', () => {
  it('sends no shadow from a terminal that is pretending to be offline', async () => {
    const fetchMock = stubFetch();
    setArm('duplicate-next-mutation', true);
    setTerminalOffline('pos-1', true);

    await expect(postMutation('order-1', request())).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(isArmed('duplicate-next-mutation')).toBe(true);
  });

  it('does not spend the conflict arm on a call that never left the browser', async () => {
    stubFetch();
    setArm('create-version-conflict', true);
    setTerminalOffline('pos-1', true);

    await expect(postMutation('order-1', request())).rejects.toThrow();

    // The operator arms this on /debug and walks to a POS that happens to be offline. An arm spent
    // by a request the offline gate refused is a control that silently does nothing.
    expect(isArmed('create-version-conflict')).toBe(true);
  });

  it('does not spend the conflict arm when the network itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    setArm('create-version-conflict', true);

    await expect(postMutation('order-1', request())).rejects.toThrow();

    expect(isArmed('create-version-conflict')).toBe(true);
  });
});

describe('the two latches', () => {
  it('are switches rather than one-shots, and survive being read', () => {
    expect(isLatched('socket-disabled')).toBe(false);

    expect(toggleLatch('socket-disabled')).toBe(true);
    expect(isLatched('socket-disabled')).toBe(true);
    expect(isLatched('polling-forced')).toBe(false);

    expect(toggleLatch('socket-disabled')).toBe(false);
  });
});

describe('the effect log', () => {
  it('records what a one-shot did, because it fires on a screen the operator has left', async () => {
    stubFetch();
    setArm('create-version-conflict', true);
    setArm('duplicate-next-mutation', true);

    await postMutation('order-1', request());

    const controls = simulatorEffects.value.map((effect) => effect.control);
    expect(controls).toContain('Create Version Conflict');
    expect(controls).toContain('Duplicate Next Mutation');
    // Newest first: the log is read from the top.
    expect(controls[controls.length - 1]).toBe('Create Version Conflict');
  });
});
