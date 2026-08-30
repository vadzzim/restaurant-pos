import { CONFIG_POLL_MS, POLLING_INTERVAL_MS, PRESENCE_HEARTBEAT_MS } from '@pos/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSimulatorArms, setLatch } from '../src/api/simulator-arms';
import { useConnectionStore, type RealtimeStartOptions } from '../src/stores/connection';

/**
 * §15's two transports, tested at the seam that chooses between them.
 *
 * The socket itself is mocked — `connectRealtime` opens a real Socket.IO client and this suite has
 * no server — but the polling transport is **not**: it is the branch this milestone had to build,
 * and a fake of it would test nothing. Its refetch and its presence beat both go through the same
 * `fetch` every other client call does.
 */
const socketMock = vi.hoisted(() => ({
  connectRealtime: vi.fn(),
  closes: 0,
}));

vi.mock('../src/realtime/socket', () => ({
  connectRealtime: socketMock.connectRealtime.mockImplementation(() => ({
    resubscribe: () => undefined,
    close: () => {
      socketMock.closes += 1;
    },
  })),
}));

/** What `GET /api/config` answers next. Flipping it is how a rollout change is simulated. */
let pushEnabled = true;

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (String(url).startsWith('/api/config')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            restaurantId: 'demo-restaurant',
            flags: { 'realtime.websocket_push': pushEnabled },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const refresh = vi.fn().mockResolvedValue(undefined);

const options = (): RealtimeStartOptions => ({
  restaurantId: 'demo-restaurant',
  role: 'pos',
  currentOrderId: () => undefined,
  heldVersion: () => 0,
  refresh,
  presence: () => ({
    terminalId: 'pos-1',
    restaurantId: 'demo-restaurant',
    role: 'pos',
    pendingCount: 1,
    offline: false,
  }),
});

const configCalls = (fetchMock: ReturnType<typeof vi.fn>): number =>
  fetchMock.mock.calls.filter((call) => String(call[0]).startsWith('/api/config')).length;

const presencePosts = (fetchMock: ReturnType<typeof vi.fn>): number =>
  fetchMock.mock.calls.filter((call) => call[0] === '/api/presence').length;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  pushEnabled = true;
  socketMock.closes = 0;
  socketMock.connectRealtime.mockClear();
  refresh.mockClear();
  // The store listens for the browser's own online/offline events at creation.
  vi.stubGlobal('window', { addEventListener: () => undefined });
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSimulatorArms();
});

describe('choosing a transport', () => {
  it('opens the socket when the flag is on for this restaurant', async () => {
    stubFetch();
    const connection = useConnectionStore();

    await connection.start(options());

    expect(connection.transport).toBe('PUSH');
    expect(socketMock.connectRealtime).toHaveBeenCalledTimes(1);

    connection.stop();
  });

  it('polls the snapshot when the flag is off, and keeps polling', async () => {
    stubFetch();
    pushEnabled = false;
    const connection = useConnectionStore();

    await connection.start(options());

    expect(connection.transport).toBe('POLLING');
    expect(socketMock.connectRealtime).not.toHaveBeenCalled();
    // Immediately, not on the next tick: the screen that just came up must not wait an interval
    // for its first canonical read.
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    connection.stop();
  });

  /** §18's per-terminal latch, which is how both transports are shown side by side. */
  it('takes the polling branch on Force Polling Transport, without asking the server', async () => {
    const fetchMock = stubFetch();
    setLatch('polling-forced', true);
    const connection = useConnectionStore();

    await connection.start(options());

    expect(connection.transport).toBe('POLLING');
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).startsWith('/api/config')),
    ).toHaveLength(0);

    connection.stop();
  });

  /**
   * A client that cannot read its configuration has not been told to poll. It opens nothing and
   * waits for the re-poll, rather than starting a transport on a guess.
   */
  it('stays UNKNOWN while /api/config is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const connection = useConnectionStore();

    await connection.start(options());

    expect(connection.transport).toBe('UNKNOWN');
    expect(socketMock.connectRealtime).not.toHaveBeenCalled();

    connection.stop();
  });
});

describe('the 15-second config poll', () => {
  it('moves an open client from push to polling with no reload', async () => {
    stubFetch();
    const connection = useConnectionStore();

    await connection.start(options());
    expect(connection.transport).toBe('PUSH');

    // The operator turns the flag off on /debug. Nothing tells this client — it asks.
    pushEnabled = false;
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);

    expect(connection.transport).toBe('POLLING');
    expect(socketMock.closes).toBe(1);

    connection.stop();
  });

  /**
   * The switch runs on the answer the poll already has. Asking a second time would mean a request
   * made *after* the working connection was closed — and losing that one would drop the client to
   * `UNKNOWN` for an interval, which is the outage this path exists to avoid. Found by the Codex
   * review of M13.
   */
  it('switches on the answer it already has, without a second request', async () => {
    const fetchMock = stubFetch();
    const connection = useConnectionStore();

    await connection.start(options());
    const before = configCalls(fetchMock);

    pushEnabled = false;
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);

    expect(connection.transport).toBe('POLLING');
    expect(configCalls(fetchMock) - before).toBe(1);
  });

  it('completes the switch even when every later request fails', async () => {
    stubFetch();
    const connection = useConnectionStore();

    await connection.start(options());
    refresh.mockClear();

    // The poll's own request is the last one that works.
    pushEnabled = false;
    let answered = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (!String(url).startsWith('/api/config')) {
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        if (answered) {
          return Promise.reject(new Error('the API went away'));
        }
        answered = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              restaurantId: 'demo-restaurant',
              flags: { 'realtime.websocket_push': false },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }),
    );

    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);

    expect(connection.transport).toBe('POLLING');
    // Polling is actually running, not merely labelled: the transport refetched on arrival.
    expect(refresh).toHaveBeenCalled();

    connection.stop();
  });

  it('leaves the connection alone while the answer is unchanged', async () => {
    stubFetch();
    const connection = useConnectionStore();

    await connection.start(options());
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS * 3);

    expect(socketMock.connectRealtime).toHaveBeenCalledTimes(1);
    expect(socketMock.closes).toBe(0);

    connection.stop();
  });

  /**
   * A failed poll is not news about the rollout. Acting on it would close a working socket over a
   * blip — a failed GET turned into the outage the flag exists to avoid.
   */
  it('keeps the transport it has when /api/config stops answering', async () => {
    stubFetch();
    const connection = useConnectionStore();

    await connection.start(options());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS * 2);

    expect(connection.transport).toBe('PUSH');
    expect(socketMock.closes).toBe(0);

    connection.stop();
  });

  it('stops with the screen, so a torn-down store has no timers left', async () => {
    stubFetch();
    const connection = useConnectionStore();

    await connection.start(options());
    connection.stop();

    pushEnabled = false;
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS * 2);

    expect(connection.transport).toBe('PUSH');
  });
});

describe('presence on the polling transport', () => {
  /**
   * `[M11, P2]`: the heartbeat used to live inside `connectRealtime`, so a terminal that declined
   * the socket vanished from `/debug`. This is the second path.
   */
  it('reports over HTTP, immediately and then on the heartbeat', async () => {
    const fetchMock = stubFetch();
    pushEnabled = false;
    const connection = useConnectionStore();

    await connection.start(options());
    expect(presencePosts(fetchMock)).toBe(1);

    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS);
    expect(presencePosts(fetchMock)).toBe(2);

    connection.stop();
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 2);
    expect(presencePosts(fetchMock)).toBe(2);
  });
});
