import { CONFIG_POLL_MS, type DomainEvent, type PresenceReport } from '@pos/contracts';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import { fetchConfig } from '../api/client';
import { isLatched, latchStates } from '../api/simulator-arms';
import { createEventGate, type GateVerdict } from '../realtime/event-gate';
import { connectPolling } from '../realtime/polling';
import { connectRealtime } from '../realtime/socket';

export type SocketState = 'DISCONNECTED' | 'CONNECTED';

/**
 * The two transports of §13, and the gap between them.
 *
 * `PUSH` is the WebSocket. `POLLING` is the complete second implementation §15 requires: when
 * `realtime.websocket_push` is off for this restaurant the client polls the snapshot instead, and
 * the screens stay correct — the difference is latency, not capability. That is what makes the flag
 * a rollout rather than a kill switch, and it is why turning it off is safe to do in front of an
 * audience.
 *
 * `UNKNOWN` is neither: `/api/config` could not be reached, so no transport has been chosen yet.
 * The 15-second re-poll below is what gets a client out of it without a reload.
 *
 * §18's `Force Polling Transport` puts one terminal on `POLLING` without touching the fleet-wide
 * flag, which is how both transports can be shown side by side before a percentage exists.
 */
export type Transport = 'PUSH' | 'POLLING' | 'UNKNOWN';

export interface RealtimeStartOptions {
  restaurantId: string;
  role: 'pos' | 'kitchen';
  currentOrderId: () => string | undefined;
  /** What the screen holds for the aggregate this event is about; 0 when it holds nothing. */
  heldVersion: (aggregateId: string) => number;
  /**
   * The canonical refetch — on either transport, the only way this client learns anything from the
   * server. The event is passed so a screen reading an eventually-consistent projection can wait
   * for it; `undefined` means a reconnect refresh, or a poll, with nothing specific to wait for.
   */
  refresh: (event: DomainEvent | undefined) => Promise<void>;
  /**
   * What this screen reports for §16's active-terminals panel, or `undefined` when it has no
   * terminal to report — the kitchen display is not one of the four seeded terminals.
   */
  presence?: () => PresenceReport | undefined;
}

/** What both transports look like to this store. Neither one is special-cased after `start`. */
interface Connection {
  resubscribe: () => void;
  close: () => void;
}

export const useConnectionStore = defineStore('connection', () => {
  const online = ref(navigator.onLine);
  const socketState = ref<SocketState>('DISCONNECTED');
  const transport = ref<Transport>('UNKNOWN');
  const lastVerdict = ref<GateVerdict | undefined>();

  const gate = createEventGate();
  let connection: Connection | undefined;
  /**
   * `start` awaits `GET /api/config` before it opens anything, and in that gap the component can
   * unmount or the terminal in the URL can change. Every `start` and `stop` claims a generation;
   * a `start` that finds its claim superseded drops what it built instead of installing it, so a
   * stale connection can neither replace a newer one nor outlive a `stop`.
   */
  let generation = 0;
  /** What the mounted screen last asked for, so a flag change or a §18 latch can rebuild it. */
  let lastOptions: RealtimeStartOptions | undefined;
  let flagPoll: ReturnType<typeof setInterval> | undefined;

  const pushEnabled = computed(() => transport.value === 'PUSH');

  window.addEventListener('online', () => {
    online.value = true;
  });
  window.addEventListener('offline', () => {
    online.value = false;
  });

  /**
   * Which transport this restaurant is on right now.
   *
   * Deliberately free of side effects: it resolves a value and writes nothing. The caller writes
   * `transport` only after checking that its generation is still current, so the late answer of a
   * cancelled `start` cannot relabel the transport of the restaurant that replaced it.
   */
  async function resolveTransport(restaurantId: string): Promise<Transport> {
    // §18's `Force Polling Transport`, per terminal and ahead of the flag: this screen takes the
    // rollout's other branch without touching a fleet-wide row that would take every other
    // terminal with it.
    if (isLatched('polling-forced')) {
      return 'POLLING';
    }

    try {
      const config = await fetchConfig(restaurantId);
      return config.flags['realtime.websocket_push'] ? 'PUSH' : 'POLLING';
    } catch {
      // Not `POLLING`: a client that cannot read its configuration has not been *told* to poll, and
      // starting a transport on a guess is how a rollout stops being traceable. The re-poll below
      // is what gets this client out of `UNKNOWN` without a reload.
      return 'UNKNOWN';
    }
  }

  function teardown(): void {
    connection?.close();
    connection = undefined;
    socketState.value = 'DISCONNECTED';
  }

  /** The socket branch. Returns `undefined` when §18 says this terminal may not open one. */
  function openPush(options: RealtimeStartOptions, mine: number): Connection | undefined {
    // §18's `Disconnect WebSocket`. It is checked here rather than by closing an open socket
    // because the operator throws it on `/debug`, where no screen holds one — a latch the next
    // `start` obeys is what makes the control work from the page it is drawn on.
    if (isLatched('socket-disabled')) {
      return undefined;
    }

    return connectRealtime({
      subscription: () => ({
        restaurantId: options.restaurantId,
        role: options.role,
        orderId: options.currentOrderId(),
      }),
      onConnected: () => {
        if (mine !== generation) {
          return;
        }
        socketState.value = 'CONNECTED';
        // §13: reconnecting means refetching the snapshot, not merely showing a green badge.
        // Anything lost in the §12.2 crash window is repaired right here.
        void options.refresh(undefined);
      },
      onDisconnected: () => {
        if (mine === generation) {
          socketState.value = 'DISCONNECTED';
        }
      },
      // Guarded by the same generation check as everything else here: a superseded connection
      // must not keep reporting a terminal the screen has left.
      presence: () => (mine === generation ? options.presence?.() : undefined),
      onEvent: (event: DomainEvent) => {
        if (mine !== generation) {
          return;
        }
        const verdict = gate.accept(event, options.heldVersion(event.aggregateId));
        lastVerdict.value = verdict;
        if (verdict === 'accepted') {
          void options.refresh(event);
        }
      },
    });
  }

  /**
   * The polling branch. No event gate and no version comparison: there is no event to judge, only
   * the snapshot itself, which is canonical by definition (§13).
   */
  function openPolling(options: RealtimeStartOptions, mine: number): Connection {
    return connectPolling({
      refresh: () => (mine === generation ? options.refresh(undefined) : Promise.resolve()),
      presence: () => (mine === generation ? options.presence?.() : undefined),
    });
  }

  /**
   * Install the transport for an answer that is already in hand. Nothing here awaits, so the old
   * connection is closed and the new one built in one turn: there is no window in which the screen
   * holds neither.
   *
   * **Whoever resolved the transport passes it in.** Resolving again here would mean a second
   * `GET /api/config` after the connection was already torn down, and a failure of *that* request
   * would drop a working client to `UNKNOWN` — the outage this whole path exists to avoid.
   */
  function open(options: RealtimeStartOptions, resolved: Transport): void {
    generation += 1;
    const mine = generation;
    teardown();

    transport.value = resolved;
    startFlagPoll();

    const opened =
      resolved === 'PUSH'
        ? openPush(options, mine)
        : resolved === 'POLLING'
          ? openPolling(options, mine)
          : undefined;

    if (opened !== undefined) {
      connection = opened;
    }
  }

  async function start(options: RealtimeStartOptions): Promise<void> {
    lastOptions = options;
    // Claimed before the await, not after: a `stop()` or a second `start()` during the fetch must
    // win, and the latch watcher must be able to supersede an answer resolved under the old latch.
    generation += 1;
    const mine = generation;

    const resolved = await resolveTransport(options.restaurantId);
    // Nothing has been torn down yet, so a superseded `start` leaves the screen exactly as it found
    // it — including a connection that is still working.
    if (mine !== generation) {
      return;
    }

    open(options, resolved);
  }

  /**
   * §15's 15-second re-poll. An already-open client learns about a rollout change here and nowhere
   * else: a socket control event would be circular — it cannot tell a client that the socket is off
   * — and forcing a reload would cost more than fifteen seconds of delay.
   *
   * It rebuilds only when the answer *changed*, so the steady state is one cheap GET every 15 s and
   * not a connection that tears itself down on a timer.
   */
  function startFlagPoll(): void {
    if (flagPoll !== undefined) {
      return;
    }

    flagPoll = setInterval(() => {
      const options = lastOptions;
      if (options === undefined) {
        return;
      }

      void resolveTransport(options.restaurantId).then((resolved) => {
        // **`UNKNOWN` is not a change.** A blip on this poll is not news about the rollout, and
        // acting on it would close a working socket and leave the screen with no transport for
        // fifteen seconds — turning a failed GET into the outage the flag exists to avoid. The
        // client keeps what it has until the endpoint answers with a transport again.
        if (resolved === 'UNKNOWN' || resolved === transport.value) {
          return;
        }
        // `lastOptions === options` is the same generation guard the rest of the store uses, in the
        // one place it cannot be a number: this answer may arrive after the screen moved on.
        //
        // `open`, not `start`: this poll has just resolved the transport, and asking again would be
        // a second request the client does not need and could lose.
        if (lastOptions === options) {
          open(options, resolved);
        }
      });
    }, CONFIG_POLL_MS);
  }

  function resubscribe(): void {
    connection?.resubscribe();
  }

  function stop(): void {
    lastOptions = undefined;
    generation += 1;
    teardown();

    if (flagPoll !== undefined) {
      clearInterval(flagPoll);
      flagPoll = undefined;
    }
  }

  /**
   * Both §18 latches change what `start` would have built, so flipping one re-runs it against the
   * screen that is up. Without this the operator would have to leave `/pos` and come back for a
   * switch thrown on `/debug` to take effect, which is a control that appears not to work.
   *
   * `stop()` clears `lastOptions`, so a latch thrown with no screen mounted rebuilds nothing.
   */
  watch(
    () => [latchStates.value['socket-disabled'], latchStates.value['polling-forced']],
    () => {
      if (lastOptions !== undefined) {
        void start(lastOptions);
      }
    },
  );

  return { online, socketState, transport, pushEnabled, lastVerdict, start, resubscribe, stop };
});
